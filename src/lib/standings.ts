import type { StandingRow } from '@/types'
import type { Tiebreaker } from './competition'

export function seedTotalsByPlayer(
  picks: { player_id: string; seed?: number | null }[]
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const pick of picks) {
    totals[pick.player_id] = (totals[pick.player_id] ?? 0) + (pick.seed ?? 0)
  }
  return totals
}

export function compareBySeedTotal(a: StandingRow, b: StandingRow): number {
  return b.seed_total - a.seed_total || b.slates_survived - a.slates_survived ||
    a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
}

function byName(a: StandingRow, b: StandingRow): number {
  return a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
}

// How survivors are ranked, per the pool's configured tiebreaker. A seed
// total only exists inside the bracket, so 'seed-total' ranks regular-season
// entries by game days survived (every seed there is zero).
export function standingsComparator(tiebreaker: Tiebreaker): (a: StandingRow, b: StandingRow) => number {
  if (tiebreaker === 'most-survived') return (a, b) => b.slates_survived - a.slates_survived || byName(a, b)
  if (tiebreaker === 'none') return byName
  return compareBySeedTotal
}
