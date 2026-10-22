import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncResults } from './syncResults'
import { runAutoAssignNow } from './autoAssign'
import { advanceSlate } from './advanceSlate'
import { queueReminders } from './reminders'
import { deliverNotifications } from './notificationWorker'
import { centralClock, reminderWindow } from './operationPolicy'
import { syncSlateFromEspn } from './espnSync'
import { getPoolConfig } from './pool'
import { gradeSlatePicks } from './grading'
import { loadAll, loadGamesForSlates } from './seasonData'
import type { Slate } from '@/types'

export const WORKLOADS = [
  'schedule',
  'results',
  'grading',
  'assignment',
  'advance',
  'reminders',
  'campaigns',
  'delivery',
  'integrity',
  'retention',
] as const
export type Workload = (typeof WORKLOADS)[number]
const interval: Record<Workload, number> = {
  schedule: 900,
  results: 60,
  grading: 60,
  assignment: 10,
  advance: 60,
  reminders: 60,
  campaigns: 5,
  delivery: 1,
  integrity: 300,
  retention: 86400,
}
// Stable keys and durable next_attempt_at survive missed/late scheduler invocations.
export async function runTournamentJob(
  db: SupabaseClient,
  kind: Workload,
  now = new Date(),
) {
  const key = `recurring:${kind}`
  const { data: token, error } = await db.rpc('claim_operation', {
    p_key: key,
    p_seconds: 240,
  })
  if (error) throw error
  if (!token) return { claimed: false }
  try {
    let progress: unknown = {}
    if (kind === 'results') {
      const response = await syncResults(db, now, { grade: false })
      progress = await response.json()
      if (!response.ok) throw new Error('Result synchronization delayed')
    } else if (kind === 'grading') {
      const slates = await loadAll<Slate>(db, 'slates', '*'),
        pool = await getPoolConfig(db, true)
      const due = slates.filter(
        (s) =>
          s.season_year === pool.season_year &&
          s.slate_date <= centralClock(now).date &&
          (!pool.starts_on || s.slate_date >= pool.starts_on),
      )
      const games = await loadGamesForSlates(
        db,
        due.map((s) => s.id),
      )
      progress = []
      for (const slate of due)
        (progress as unknown[]).push(
          await gradeSlatePicks(
            db,
            slate.id,
            slate.slate_number,
            games.filter(
              (g) => g.slate_id === slate.id && g.result !== 'pending',
            ),
          ),
        )
    } else if (kind === 'schedule') {
      const pool = await getPoolConfig(db, true),
        today = centralClock(now).date
      const response = await syncSlateFromEspn(
        db,
        today.replaceAll('-', ''),
        pool.season_year,
      )
      if (
        (!response.ok && !response.error?.startsWith('No games found')) ||
        response.partial?.length
      )
        throw new Error('Schedule feed incomplete')
      progress = response
    } else if (kind === 'assignment') {
      const assignment = await runAutoAssignNow(db, now)
      if (!assignment.ok) throw new Error('Assignment batch incomplete')
      progress = assignment
    } else if (kind === 'advance') {
      if (centralClock(now).hour >= 3) {
        const response = await advanceSlate(db, now, 'system')
        progress = await response.json()
        if (!response.ok) throw new Error('Advancement deferred')
      }
    } else if (kind === 'reminders') {
      const { data: requirement, error } = await db.rpc(
        'active_pick_requirement',
      )
      if (error) throw error
      const window = requirement?.deadline
        ? reminderWindow(new Date(requirement.deadline), now)
        : null
      if (window) {
        const response = await queueReminders(db, now, window)
        progress = await response.json()
        if (!response.ok) throw new Error('Reminder intent generation failed')
      }
    } else if (kind === 'campaigns') {
      const { data, error } = await db
        .from('email_campaigns')
        .select('id')
        .eq('status', 'expanding')
        .order('created_at')
        .limit(3)
      if (error) throw error
      for (const campaign of data ?? []) {
        const result = await db.rpc('expand_campaign', {
          p_id: campaign.id,
          p_limit: 200,
        })
        if (result.error) throw result.error
      }
      progress = { campaigns: data?.length ?? 0 }
    } else if (kind === 'delivery') {
      const until = Date.now() + 160000
      let accepted = 0,
        passes = 0
      do {
        const batch = await deliverNotifications(db)
        accepted += batch.accepted
        passes++
        if (batch.disabled || batch.accepted === 0) break
      } while (Date.now() < until)
      progress = { accepted, passes }
    } else if (kind === 'integrity') {
      const result = await db.rpc('reconcile_contest')
      if (result.error) throw result.error
      progress = result.data
    } else {
      const cleanup = await db.rpc('delivery_retention')
      if (cleanup.error) throw cleanup.error
      const result = await db.rpc('operation_retention', { p_apply: true })
      if (result.error) throw result.error
      progress = result.data
    }
    const result = await db.rpc('finish_recurring_operation', {
      p_key: key,
      p_token: token,
      p_interval: interval[kind],
      p_progress: progress,
    })
    if (result.error || !result.data)
      throw result.error ?? new Error('Stale job completion rejected')
    return { claimed: true, progress }
  } catch (error) {
    await db.rpc('finish_operation', {
      p_key: key,
      p_token: token,
      p_done: false,
      p_error: 'Workload failed; see incident and correlation ID',
    })
    throw error
  }
}
