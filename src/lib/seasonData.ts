import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game } from '@/types'
import { selectAll, selectAllIn } from './db'

// Season-wide reads, paged so they stay complete past PostgREST's row cap
// (see lib/db.ts). Anything that reads more than one slate's games or picks
// should come through here rather than a bare `.select()`.

export async function loadGamesForSlates<T = Game>(
  db: SupabaseClient,
  slateIds: string[],
  columns = '*'
): Promise<T[]> {
  return selectAllIn<T>(slateIds, (batch, from, to) =>
    db.from('games').select(columns).in('slate_id', batch).order('id').range(from, to)
  )
}

// The season's tournament games, reduced to the two columns pick periods are
// built from (buildPickPeriods). Games outside the bracket carry no round, so
// they are skipped at the source — a full season is thousands of rows, the
// bracket a few dozen.
export async function loadRoundLabels(
  db: SupabaseClient,
  slateIds: string[]
): Promise<{ slate_id: string; round_label: string }[]> {
  return selectAllIn(slateIds, (batch, from, to) =>
    db
      .from('games')
      .select('slate_id, round_label')
      .in('slate_id', batch)
      .not('round_label', 'is', null)
      .order('id')
      .range(from, to)
  )
}

export async function loadPicksForSlates<T>(
  db: SupabaseClient,
  slateIds: string[],
  columns: string
): Promise<T[]> {
  return selectAllIn<T>(slateIds, (batch, from, to) =>
    db.from('picks').select(columns).in('slate_id', batch).order('id').range(from, to)
  )
}

// Every row of a table, paged. For admin exports and history views that
// deliberately span seasons.
export async function loadAll<T>(db: SupabaseClient, table: string, columns: string): Promise<T[]> {
  return selectAll<T>((from, to) => db.from(table).select(columns).order('id').range(from, to))
}

// The season a page should describe: the active slate's, or the newest one
// on record when nothing is active. Matches getDashboardData's anchor.
export function seasonYearOf(
  slates: { season_year: number; is_active?: boolean }[]
): number | null {
  const active = slates.find((slate) => slate.is_active)
  if (active) return active.season_year
  return slates.reduce<number | null>((max, slate) => (max === null || slate.season_year > max ? slate.season_year : max), null)
}
