import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openRequest, renderNotification, type DeliveryEvent } from './delivery'
import { deliveryFailure } from './deliveryPolicy'
import { buildPickPeriods, sharedRoundPickQuota } from './competition'
import { loadAll, loadGamesForSlates } from './seasonData'
import { getPoolConfig } from './pool'
import type { Slate } from '@/types'

export async function deliverNotifications(db: SupabaseClient) {
  if (
    process.env.EMAILS_ENABLED !== 'true' ||
    process.env.OUTBOX_DELIVERY_ENABLED !== 'true'
  )
    return { accepted: 0, disabled: true }
  if (!process.env.RESEND_API_KEY)
    throw new Error('Email provider not configured')
  const { data, error } = await db.rpc('claim_notifications', { p_limit: 30 })
  if (error) throw error
  const events = (data ?? []) as DeliveryEvent[]
  let accepted = 0
  // Shared round/quota inputs loaded once per batch. The per-recipient count is targeted.
  const reminderPeriods = new Map<string, { ids: string[]; quota: number;active:boolean;deadline:string|null }>()
  if (events.some((e) => e.kind === 'reminder')) {
    const [pool, slates] = await Promise.all([
      getPoolConfig(db, true),
      loadAll<Slate>(db, 'slates', '*'),
    ])
    const games = await loadGamesForSlates(
      db,
      slates.map((s) => s.id),
    )
    const periods = buildPickPeriods(pool.competition_mode, slates, games)
    for (const period of periods) {
      const quota = sharedRoundPickQuota(
        pool.competition_mode,
        pool.pick_frequency,
        period.round,
      )
      reminderPeriods.set(period.id, {
        ids: quota
          ? periods.filter((p) => p.round === period.round).map((p) => p.id)
          : [period.id],
        quota: quota ?? 1,active:!!slates.find(s=>s.id===period.id)?.is_active,deadline:slates.find(s=>s.id===period.id)?.locks_at??null,
      })
    }
  }
  for (const event of events) {
    const settle = async (
      state: string,
      code: string | null = null,
      id: string | null = null,
      delay = 60,
    ) => {
      const result = await db.rpc('settle_notification', {
        p_id: event.id,
        p_token: event.lease_token,
        p_status: state,
        p_code: code,
        p_provider_id: id,
        p_delay: delay,
      })
      if (result.error || !result.data)
        throw result.error ?? new Error('Delivery lease lost')
    }
    try {
      if (new Date(event.expires_at).getTime() <= Date.now()) {
        await settle('expired', 'Message expired')
        continue
      }
      const { data: settings, error: settingsError } = await db
        .from('delivery_settings')
        .select('mode,allowlist,paused_until')
        .eq('id', true)
        .single()
      if (settingsError) throw settingsError
      if (
        settings.mode === 'record-only' ||
        (settings.mode === 'test-recipients' &&
          !settings.allowlist.includes(event.recipient))
      ) {
        await settle('canceled', 'Delivery mode changed')
        continue
      }
      if (
        settings.paused_until &&
        new Date(settings.paused_until).getTime() > Date.now()
      ) {
        await settle('pending', 'Provider paused', null, 300)
        continue
      }
      const { data: suppression, error: suppressionError } = await db
        .from('email_suppressions')
        .select('email')
        .eq('email', event.recipient)
        .maybeSingle()
      if (suppressionError) throw suppressionError
      if (
        suppression ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(event.recipient) ||
        /\.(test|invalid)$|@nflsurvivor.internal$/i.test(event.recipient)
      ) {
        await settle('suppressed', 'Recipient suppressed or invalid')
        continue
      }
      if (
        event.kind === 'password-reset' &&
        process.env.PASSWORD_RESET_EMAILS_ENABLED !== 'true'
      ) {
        await settle('suppressed', 'Recovery email switch is disabled')
        continue
      }
      if (event.player_id) {
        const { data: player, error: playerError } = await db
          .from('players')
          .select('status,notifications_enabled,pin_reset_expires')
          .eq('id', event.player_id)
          .maybeSingle()
        if (playerError) throw playerError
        if (
          !player ||
          (event.kind !== 'password-reset' && !player.notifications_enabled) ||
          (event.kind === 'elimination' && player.status !== 'eliminated')
        ) {
          await settle('suppressed', 'Recipient no longer eligible')
          continue
        }
        if (event.kind === 'reminder') {
          const period = reminderPeriods.get(String(event.payload.slate_id))
          if (!period || !period.active || !period.deadline || new Date(period.deadline).getTime()<=Date.now() || player.status !== 'alive') {
            await settle('suppressed', 'Period no longer eligible')
            continue
          }
          const { count, error } = await db
            .from('picks')
            .select('id', { count: 'exact', head: true })
            .eq('player_id', event.player_id)
            .in('slate_id', period.ids)
          if (error) throw error
          if ((count ?? 0) >= period.quota) {
            await settle('suppressed', 'Required quota already complete')
            continue
          }
        }
        if (
          event.kind === 'password-reset' &&
          (!player.pin_reset_expires ||
            new Date(player.pin_reset_expires).getTime() <=
              Date.now() + 60000 ||
            new Date(player.pin_reset_expires).getTime() !==
              new Date(String(event.payload.reset_expires)).getTime())
        ) {
          await settle('expired', 'Recovery link expired')
          continue
        }
      }
      // One database gate covers all workers; no per-process rate assumption.
      let slot = false
      for (let tries = 0; tries < 15 && !slot; tries++) {
        const result = await db.rpc('reserve_email_slot')
        if (result.error) throw result.error
        slot = !!result.data
        if (!slot) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!slot) {
        await settle('pending', 'Shared provider rate gate', null, 5)
        continue
      }
      const { data: frozen, error: prepareError } = await db.rpc(
        'prepare_notification',
        {
          p_id: event.id,
          p_token: event.lease_token,
          p_request: event.frozen_request ?? renderNotification(event),
        },
      )
      if (prepareError) throw prepareError
      if (!frozen) {
        await settle(
          'review',
          'Lease, mode, expiry or idempotency boundary changed',
        )
        continue
      }
      const request = openRequest(frozen)
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `madness/${event.id}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10000),
      })
      const body = await response.json().catch(() => ({}))
      if (response.ok && typeof body.id === 'string') {
        await settle('sent', null, body.id)
        accepted++
      } else {
        const failure = deliveryFailure(
          response.status,
          String(body.name ?? body.message ?? ''),
          event.attempts + 1,
          response.headers.get('retry-after'),
        )
        if (failure.pause) {
          const { error } = await db
            .from('delivery_settings')
            .update({
              paused_until: new Date(
                Date.now() + failure.delay * 1000,
              ).toISOString(),
              pause_reason: failure.code,
            })
            .eq('id', true)
          if (error) throw error
        }
        await settle(failure.state, failure.code, null, failure.delay)
      }
    } catch {
      // Never log provider bodies or sensitive frozen payloads. Same key/payload on retry.
      await settle(
        'pending',
        'Delivery interrupted; reconcile with same idempotency key',
        null,
        120,
      )
    }
  }
  return { accepted, disabled: false }
}
