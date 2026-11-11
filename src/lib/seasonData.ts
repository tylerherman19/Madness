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

// Slates are shared by every contest (migration 030), so a slate's picks can
// belong to more than one contest. Pass `poolId` to read one contest's picks;
// an empty id (no pool row) matches nothing rather than every contest.
export async function loadPicksForSlates<T>(
  db: SupabaseClient,
  slateIds: string[],
  columns: string,
  poolId?: string
): Promise<T[]> {
  return selectAllIn<T>(slateIds, (batch, from, to) => {
    const query = db.from('picks').select(columns).in('slate_id', batch)
    return (poolId === undefined ? query : query.eq('pool_id', poolId || '00000000-0000-0000-0000-000000000000')).order('id').range(from, to)
  })
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
