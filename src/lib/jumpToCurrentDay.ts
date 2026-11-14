import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncSlateFromEspn } from './espnSync'
import { slateDeadline } from './deadline'
import { staleDay, centralDate, longDate } from './staleDay'
import { getActiveDayStatus, assignmentGuard } from './slateStatus'
import { resolveByPrefix } from './incidents'
import { logAudit } from './audit'
import { revalidateContest } from './revalidateContest'
import type { Game } from '@/types'

const MAX_LOOKAHEAD_DAYS = 10

export type JumpResult =
  | { ok: true; toDate: string; toSlateId: string; skippedDates: string[]; resolvedIncidents: number }
  | { ok: false; status: number; code: string; error: string }

const fail = (status: number, code: string, error: string): JumpResult => ({ ok: false, status, code, error })

// "Jump to the current day": make the first day whose pick deadline has not passed the active day,
// skipping every day in between. Skipped days are not assigned and nobody is eliminated for them:
// auto-assignment and elimination for a missed pick only ever run on the ACTIVE day, and a skipped
// day is never active again. Results already in for skipped days are still graded by the grading job.
export async function jumpToCurrentDay(
  db: SupabaseClient, now: Date, reason: string, override: boolean,
): Promise<JumpResult> {
  const { data: active, error } = await db.from('slates').select('id, slate_number, slate_date, season_year').eq('is_active', true).maybeSingle()
  if (error) throw error
  if (!active) return fail(409, 'no-active-day', 'There is no active day to move from. Set a day on the Schedule page.')
  const state = staleDay(active.slate_date, now)
  if (!state.stale) return fail(409, 'not-stale', 'The active day is already the current day. Nothing to jump.')

  const current = await getActiveDayStatus(db, now)
  const guard = current ? assignmentGuard(current) : { blocked: false, message: null }
  if (guard.blocked && !override) {
    return fail(409, 'assignment-incomplete',
      `${current?.unpicked} alive ${current?.unpicked === 1 ? 'entry has' : 'entries have'} no pick for ${longDate(active.slate_date)}. Jumping skips that day: those entries are NOT given a pick and are NOT eliminated for it. Confirm to skip it anyway.`)
  }

  // First day (today or later) with games whose deadline has not passed. Days not stored yet are fetched.
  const today = centralDate(now)
  let target: { id: string; date: string } | null = null
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS && !target; i++) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
    if (date <= active.slate_date) continue
    const stored = async () => {
      const { data: slate, error: slateError } = await db.from('slates').select('id, slate_date, locks_at').eq('season_year', active.season_year).eq('slate_date', date).maybeSingle()
      if (slateError) throw slateError
      if (!slate) return null
      const { data: games, error: gamesError } = await db.from('games').select('*').eq('slate_id', slate.id)
      if (gamesError) throw gamesError
      return (games ?? []).length ? { slate, games: games as Game[] } : null
    }
    let found = await stored()
    if (!found) {
      const synced = await syncSlateFromEspn(db, date.replaceAll('-', ''), active.season_year)
      if (synced.partial?.length || (!synced.ok && !synced.error?.startsWith('No games found'))) {
        return fail(502, 'schedule-incomplete', `The schedule for ${longDate(date)} could not be loaded completely. Try again in a few minutes.`)
      }
      if (synced.reviewGames?.length) return fail(409, 'schedule-review', `The schedule for ${longDate(date)} needs review on the Schedule page before it can become the active day.`)
      found = await stored()
    }
    if (!found) continue
    const deadline = slateDeadline(found.slate, found.games)
    if (!deadline || deadline.getTime() > now.getTime()) target = { id: found.slate.id, date }
  }
  if (!target) return fail(409, 'no-open-day', `No upcoming day with games and an open pick deadline was found in the next ${MAX_LOOKAHEAD_DAYS} days. Check the Schedule page.`)

  const { data: skipped, error: skippedError } = await db.from('slates').select('slate_date').eq('season_year', active.season_year).gte('slate_date', active.slate_date).lt('slate_date', target.date).order('slate_date')
  if (skippedError) throw skippedError
  const skippedDates = (skipped ?? []).map((row: { slate_date: string }) => row.slate_date)

  const { error: activateError } = await db.rpc('activate_slate', { p_slate_id: target.id })
  if (activateError) throw activateError

  const resolvedIncidents = await resolveByPrefix(db, 'turnover-missed:', `Resolved by "Jump to the current day": ${reason}`)
  await logAudit(db, {
    event_type: 'slate-activated',
    actor: 'admin',
    message: `Jumped to the current day: ${target.date}. Skipped ${skippedDates.length} day${skippedDates.length === 1 ? '' : 's'} without assigning picks or eliminating anyone`,
    details: {
      reason, jumped: true, slate_id: target.id, from_slate_date: active.slate_date, to_slate_date: target.date,
      skipped_dates: skippedDates, override: guard.blocked && override, unpicked_at_change: current?.unpicked ?? null,
      resolved_incidents: resolvedIncidents,
    },
  })
  revalidateContest()
  return { ok: true, toDate: target.date, toSlateId: target.id, skippedDates, resolvedIncidents }
}
