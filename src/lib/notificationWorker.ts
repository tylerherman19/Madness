import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { FROM_EMAIL, esc, sleep } from './email'

type Event = { id: string; event_key: string; kind: string; lease_token: string; payload: { player_id?: string; slate_id?: string; deadline?: string; name?: string; slate_number?: number; reason?: string } }
export async function deliverNotifications(db: SupabaseClient) {
  if (process.env.EMAILS_ENABLED !== 'true' || process.env.OUTBOX_DELIVERY_ENABLED !== 'true') return { sent: 0, suppressed: true }
  if (!process.env.RESEND_API_KEY) throw new Error('Email provider is not configured')
  const { data, error } = await db.rpc('claim_notifications', { p_limit: 10 })
  if (error) throw error
  const client = new Resend(process.env.RESEND_API_KEY)
  let sent = 0
  for (const event of (data ?? []) as Event[]) {
    const finish = async (args: Record<string, unknown>) => {
      const { data: ok, error } = await db.rpc('finish_notification', { p_id: event.id, p_token: event.lease_token, ...args })
      if (error || !ok) throw error ?? new Error('Notification lease expired')
    }
    const { data: player, error: playerError } = await db.from('players').select('email, full_name, status, notifications_enabled').eq('id', event.payload.player_id).maybeSingle()
    if (playerError) throw playerError
    let review = !player || !player.notifications_enabled || !['reminder', 'elimination'].includes(event.kind)
    if (event.kind === 'elimination' && player?.status !== 'eliminated') review = true
    if (event.kind === 'reminder') {
      const deadline = new Date(event.payload.deadline ?? '').getTime()
      if (!Number.isFinite(deadline) || deadline <= Date.now() || player?.status !== 'alive') review = true
      // Recheck the whole shared quota immediately before sending.
      const { buildPickPeriods, sharedRoundPickQuota } = await import('./competition')
      const { getPoolConfig } = await import('./pool')
      const { loadAll, loadGamesForSlates, loadPicksForSlates } = await import('./seasonData')
      const { slateDeadline } = await import('./deadline')
      const pool = await getPoolConfig(db, true)
      const allSlates = await loadAll<import('@/types').Slate>(db, 'slates', '*')
      const slate = allSlates.find(row => row.id === event.payload.slate_id)
      const slates = allSlates.filter(row => row.season_year === slate?.season_year && (!pool.starts_on || row.slate_date >= pool.starts_on))
      const games = await loadGamesForSlates(db, slates.map(row => row.id))
      const actualDeadline = slateDeadline(slate ?? null, games.filter(row => row.slate_id === slate?.id))
      if (!slate?.is_active || !actualDeadline || actualDeadline <= new Date()) review = true
      const periods = buildPickPeriods(pool.competition_mode, slates, games)
      const period = periods.find(row => row.id === slate?.id)
      const quota = sharedRoundPickQuota(pool.competition_mode, pool.pick_frequency, period?.round ?? null)
      const ids = quota ? periods.filter(row => row.round === period?.round).map(row => row.id) : [slate?.id ?? '']
      const picks = await loadPicksForSlates<{player_id: string}>(db, ids, 'player_id')
      if (picks.filter(row => row.player_id === event.payload.player_id).length >= (quota ?? 1)) review = true
    }
    if (player) {
      const { data: suppression, error } = await db.from('email_suppressions').select('email').eq('email', player.email.trim().toLowerCase()).maybeSingle()
      if (error) throw error
      if (suppression || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(player.email) || /\.(test|invalid)$/i.test(player.email)) review = true
    }
    if (review) { await finish({ p_review: true, p_error: 'No longer eligible for delivery' }); continue }
    if (event.kind === 'reminder' && new Date(event.payload.deadline ?? '').getTime() <= Date.now()) { await finish({ p_review: true, p_error: 'Reminder deadline passed' }); continue }
    const subject = event.kind === 'reminder' ? 'Madness: your pick deadline is approaching' : 'Madness: entry eliminated'
    const message = event.kind === 'reminder' ? `Your pick is due before ${event.payload.deadline}. Open Madness to complete your picks.` : 'Your entry has been eliminated. Check your results in Madness.'
    const url = new URL('/notifications', process.env.NEXT_PUBLIC_APP_URL ?? 'https://madness-cyan.vercel.app').toString()
    try {
      const result = await client.emails.send({ from: FROM_EMAIL, to: player!.email, subject,
        html: `<p>Hi ${esc(player!.full_name)},</p><p>${esc(message)}</p><p><a href="${esc(url)}">Manage notification preferences</a></p>` },
        { idempotencyKey: `madness/${event.id}` })
      if (result.error || !result.data?.id) await finish({ p_error: 'Provider rejected delivery; review provider logs' })
      else { await finish({ p_provider_id: result.data.id }); sent++ }
    } catch { await finish({ p_error: 'Provider request failed; retry with the same idempotency key' }) }
    await sleep(600)
  }
  return { sent, suppressed: false }
}
