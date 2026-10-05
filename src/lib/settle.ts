import 'server-only'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { Game } from '@/types'
import { selectAllIn } from './db'
import { isSlateSettled } from './deadline'
import { syncSlateFromEspn } from './espnSync'
import { gradeSlatePicks, type GradeResult } from './grading'

// Getting game days graded — including a day a failed night skipped.
//
// The results job used to look at the active day only. If its one run failed
// (ESPN down at 3 AM, a timeout), the 6 AM advance moved the pool on and that
// day was never graded: everyone who lost stayed alive and kept picking.
//
// Now every day up to and including the active one that isn't settled yet
// (slates.graded_at, migration 022) is synced from ESPN and graded, oldest
// first. A day is settled once its games are all decided and every pick on it
// graded. Settled days are never re-graded automatically, so an administrator
// restoring a player on one of them isn't undone by the next run.
//
// Used by the nightly results cron (and its admin button) and by the 6 AM
// advance, which gives the outgoing day a second chance before moving on.

export interface SettleSlate {
  id: string
  slate_number: number
  slate_date: string
  season_year: number
}

export interface SettleOutcome {
  slate_id: string
  slate_number: number
  slate_date: string
  synced: boolean
  games_synced?: number
  partial?: string[]
  sync_error?: string
  grading: GradeResult | null
  settled: boolean
  error?: string
}

export interface SettleReport {
  active: SettleSlate | null
  // False until migration 022 adds slates.graded_at. The job then grades the
  // active day only, every run — exactly what it did before.
  tracking: boolean
  outcomes: SettleOutcome[]
  // Earlier unsettled days left for the next run (over the per-run cap).
  deferred: number
}

// Each day is an ESPN sync plus a grading pass. Ten fits comfortably inside
// the five-minute function limit; a longer backlog drains over later runs.
const MAX_EARLIER_DAYS_PER_RUN = 10

// A day this far behind the active one is settled after a clean ESPN sync
// even if a game on it is still undecided — a postponement ESPN never closes
// out, or a hand-entered game nobody scored — so one stuck game can't keep a
// day re-grading forever. Picks on such a game are left for the administrator.
export const SETTLE_AFTER_DAYS = 3

const SLATE_COLUMNS = 'id, slate_number, slate_date, season_year'

// Before 022 the column doesn't exist: Postgres reports an undefined column
// (42703) on a read, PostgREST a schema-cache miss (PGRST204) on a write.
function isMissingColumn(error: PostgrestError): boolean {
  return error.code === '42703' || error.code === 'PGRST204'
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${String(fromDate).slice(0, 10)}T12:00:00Z`).getTime()
  const to = new Date(`${String(toDate).slice(0, 10)}T12:00:00Z`).getTime()
  return Math.round((to - from) / 86_400_000)
}

// Record (or clear) a day's settled mark. Best effort: before 022 there is no
// column to write, and grading has already happened either way.
export async function recordSettlement(db: SupabaseClient, slateId: string, settled: boolean): Promise<void> {
  const { error } = await db
    .from('slates')
    .update({ graded_at: settled ? new Date().toISOString() : null })
    .eq('id', slateId)
  if (error && !isMissingColumn(error)) {
    console.error(`Could not record grading state for slate ${slateId}:`, error.message)
  }
}

// Grade a day from the results stored for it. Returns the day's games so the
// caller can tell whether it is settled.
export async function gradeStoredSlate(
  db: SupabaseClient,
  slate: Pick<SettleSlate, 'id' | 'slate_number'>
): Promise<{ games: Game[]; grading: GradeResult | null }> {
  const { data, error } = await db.from('games').select('*').eq('slate_id', slate.id)
  if (error) throw error
  const games = (data ?? []) as Game[]
  const completed = games.filter((game) => game.result !== 'pending')
  const grading =
    completed.length > 0 ? await gradeSlatePicks(db, slate.id, slate.slate_number, completed) : null
  return { games, grading }
}

// Mark the day settled when nothing on it is left to grade. Used by the
// admin's manual grading paths, which grade first and then ask this.
export async function settleIfDecided(
  db: SupabaseClient,
  slateId: string,
  games: Pick<Game, 'result' | 'status_state'>[],
  grading: GradeResult | null
): Promise<boolean> {
  const settled = isSlateSettled(games) && !grading?.failed.length
  if (settled) await recordSettlement(db, slateId, true)
  return settled
}

async function slatesWithPicks(db: SupabaseClient, slateIds: string[]): Promise<Set<string>> {
  const rows = await selectAllIn<{ slate_id: string }>(slateIds, (batch, from, to) =>
    db.from('picks').select('slate_id').in('slate_id', batch).order('id').range(from, to)
  )
  return new Set(rows.map((row) => row.slate_id))
}

async function settleSlate(
  db: SupabaseClient,
  slate: SettleSlate,
  options: { activeDate: string; syncFromEspn: boolean; tracking: boolean }
): Promise<SettleOutcome> {
  const outcome: SettleOutcome = {
    slate_id: slate.id,
    slate_number: slate.slate_number,
    slate_date: String(slate.slate_date).slice(0, 10),
    synced: false,
    grading: null,
    settled: false,
  }

  try {
    // Whether ESPN fully answered for the day — the stale backstop below
    // only trusts "still undecided" when nothing failed to load.
    let syncClean = !options.syncFromEspn
    if (options.syncFromEspn) {
      try {
        const sync = await syncSlateFromEspn(db, outcome.slate_date.replace(/-/g, ''), slate.season_year)
        if (sync.ok) {
          outcome.synced = true
          outcome.games_synced = sync.gamesSynced
          outcome.partial = sync.partial
          syncClean = !sync.partial?.length
        } else {
          outcome.sync_error = sync.error
          // A day made only of hand-entered games has nothing on ESPN.
          syncClean = !!sync.error?.startsWith('No games found')
        }
      } catch (err) {
        outcome.sync_error = err instanceof Error ? err.message : String(err)
      }
    }

    // Grade whatever is final in the database even when the sync failed:
    // results stored by an earlier sync or entered by hand are still good.
    const { games, grading } = await gradeStoredSlate(db, slate)
    outcome.grading = grading

    const stale = syncClean && daysBetween(outcome.slate_date, options.activeDate) >= SETTLE_AFTER_DAYS
    outcome.settled = (isSlateSettled(games) || stale) && !grading?.failed.length
    if (options.tracking && outcome.settled) await recordSettlement(db, slate.id, true)
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err)
    console.error(`Grading slate ${slate.id} (${outcome.slate_date}) failed:`, err)
  }

  return outcome
}

// The active day plus every earlier day of its season that isn't settled
// yet, or just the active day before migration 022.
async function loadOpenSlates(
  db: SupabaseClient
): Promise<{ active: SettleSlate | null; tracking: boolean; open: SettleSlate[] }> {
  const { data: active, error: activeError } = await db
    .from('slates')
    .select(SLATE_COLUMNS)
    .eq('is_active', true)
    .maybeSingle<SettleSlate>()
  if (activeError) throw activeError
  if (!active) return { active: null, tracking: true, open: [] }

  const { data: open, error } = await db
    .from('slates')
    .select(SLATE_COLUMNS)
    .eq('season_year', active.season_year)
    .lte('slate_date', active.slate_date)
    .is('graded_at', null)
    .order('slate_date', { ascending: true })
  if (error) {
    if (isMissingColumn(error)) return { active, tracking: false, open: [active] }
    throw error
  }
  return { active, tracking: true, open: (open ?? []) as SettleSlate[] }
}

export async function settleOutstandingSlates(
  db: SupabaseClient,
  { syncEarlierDays = true }: { syncEarlierDays?: boolean } = {}
): Promise<SettleReport> {
  const { active, tracking, open } = await loadOpenSlates(db)
  if (!active) return { active: null, tracking, outcomes: [], deferred: 0 }

  const earlier = open.filter((slate) => slate.id !== active.id)
  const activeOpen = open.some((slate) => slate.id === active.id)

  // An earlier day nobody picked on has nothing to grade, and no pick can be
  // added to it any more — settle it without asking ESPN.
  const picked = await slatesWithPicks(db, earlier.map((slate) => slate.id))
  for (const slate of earlier) {
    if (!picked.has(slate.id)) await recordSettlement(db, slate.id, true)
  }
  const backlog = earlier.filter((slate) => picked.has(slate.id))
  const batch = backlog.slice(0, MAX_EARLIER_DAYS_PER_RUN)

  // Oldest first, the active day last: a player who lost on two open days is
  // out as of the first of them.
  const outcomes: SettleOutcome[] = []
  for (const slate of batch) {
    outcomes.push(
      await settleSlate(db, slate, { activeDate: active.slate_date, syncFromEspn: syncEarlierDays, tracking })
    )
  }
  if (activeOpen) {
    outcomes.push(await settleSlate(db, active, { activeDate: active.slate_date, syncFromEspn: true, tracking }))
  }

  return { active, tracking, outcomes, deferred: backlog.length - batch.length }
}

// Earlier days of the active season that still have picks waiting on a
// grade, for the admin warning. Empty before migration 022 (tracking false).
export async function findOpenEarlierSlates(
  db: SupabaseClient
): Promise<{ tracking: boolean; slates: SettleSlate[] }> {
  const { active, tracking, open } = await loadOpenSlates(db)
  if (!active || !tracking) return { tracking, slates: [] }
  const earlier = open.filter((slate) => slate.id !== active.id)
  const picked = await slatesWithPicks(db, earlier.map((slate) => slate.id))
  return { tracking, slates: earlier.filter((slate) => picked.has(slate.id)) }
}
