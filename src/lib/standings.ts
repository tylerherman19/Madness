import type { Game, StandingRow } from '@/types'
import { isPickRevealed } from './deadline.ts'

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

// The team that knocked each eliminated entry out: their pick on the day they
// were eliminated. An admin can eliminate an entry on a day that has not
// locked yet, so a pick is listed only once its day is revealed and its game
// is a final the team lost; before that it stays hidden like every other pick.
export function revealedLosingPicks(
  eliminated: { id: string; out: number }[],
  picks: { player_id: string; slate_id: string; team: string }[],
  slates: { id: string; slate_number: number; locks_at?: string | null }[],
  gamesBySlate: Map<string, { home_team: string; away_team: string; result: string }[]>,
  now: Date
): Record<string, string[]> {
  const outByPlayer = new Map(eliminated.map((entry) => [entry.id, entry.out]))
  const slateById = new Map(slates.map((slate) => [slate.id, slate]))
  const lost: Record<string, string[]> = {}
  for (const pick of picks) {
    const out = outByPlayer.get(pick.player_id)
    const day = slateById.get(pick.slate_id)
    if (out == null || !day || day.slate_number !== out) continue
    const games = gamesBySlate.get(day.id) ?? []
    if (!isPickRevealed(day, games as Game[], now)) continue
    const game = games.find((g) => g.home_team === pick.team || g.away_team === pick.team)
    if (!game || !(game.result === 'tie' || game.result === (game.home_team === pick.team ? 'away_win' : 'home_win'))) continue
    lost[pick.player_id] = [...(lost[pick.player_id] ?? []), pick.team]
  }
  return lost
}
