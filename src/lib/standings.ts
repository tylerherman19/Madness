import type { StandingRow } from '@/types'

export function seedTotalsByPlayer(
  picks: { player_id: string; seed?: number | null }[]
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const pick of picks) {
    totals[pick.player_id] = (totals[pick.player_id] ?? 0) + (pick.seed ?? 0)
  }
  return totals
}

// How many pick periods a player has entered, counted as distinct slates
// rather than as pick rows. Migration 018 dropped the one-pick-per-slate
// constraint so a tournament round's quota can be spent across that round's
// playing days however the player likes — including both picks on the same
// day. Counting rows would credit that player with two slates survived for
// one day played, and the number is not merely cosmetic: it is the
// `most-survived` tiebreak and the runner-up tiebreak inside
// compareBySeedTotal.
export function slatesSurvivedByPlayer(
  picks: { player_id: string; slate_id: string }[]
): Record<string, number> {
  const slatesByPlayer: Record<string, Set<string>> = {}
  for (const pick of picks) {
    const slates = slatesByPlayer[pick.player_id] ?? new Set<string>()
    slates.add(pick.slate_id)
    slatesByPlayer[pick.player_id] = slates
  }
  const totals: Record<string, number> = {}
  for (const playerId of Object.keys(slatesByPlayer)) {
    totals[playerId] = slatesByPlayer[playerId].size
  }
  return totals
}

export function compareBySeedTotal(a: StandingRow, b: StandingRow): number {
  return b.seed_total - a.seed_total || b.slates_survived - a.slates_survived ||
    a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
}
