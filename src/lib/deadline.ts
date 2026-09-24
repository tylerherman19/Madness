import type { Game } from '@/types'

// Only the lock instant is read, so callers can pass a narrow select without
// casting a partial row to the full Slate type.
export type SlateLock = { locks_at?: string | null } | null

const CHICAGO_TZ = 'America/Chicago'

// Parse a tip time, returning null rather than an Invalid Date. Guards
// against a caller that selected a narrower column set and left tip_time out:
// an Invalid Date is truthy but compares false against every other date,
// which silently reads as "the deadline never passes".
function tipOf(game: Game): Date | null {
  const d = new Date(game?.tip_time)
  return isNaN(d.getTime()) ? null : d
}

// The whole slate locks at once, on the day's first tip. This is the single
// rule that replaced the NFL pool's per-game/Sunday-noon split: with games
// every day, a per-game deadline would let someone watch the early window
// before committing, and there is no weekly anchor to fall back on.
// Games whose tip time ESPN hasn't announced are skipped: their stored
// timestamp is a midnight-Eastern placeholder, and treating it as a tip would
// lock the slate at 11pm the night before. A slate where nothing is announced
// yet has no deadline — picks stay open until real times land, which the
// daily re-sync picks up.
export function getSlateDeadline(games: Game[]): Date | null {
  let earliest: Date | null = null
  for (const g of games) {
    if (g.time_tbd) continue
    const tip = tipOf(g)
    if (!tip) continue
    if (!earliest || tip < earliest) earliest = tip
  }
  return earliest
}

// Prefer the slate's cached `locks_at` (written at sync time) and fall back to
// deriving it from the games. The cache exists so callers that only need the
// deadline don't have to load the whole slate.
export function slateDeadline(slate: SlateLock, games: Game[]): Date | null {
  if (slate?.locks_at) {
    const d = new Date(slate.locks_at)
    if (!isNaN(d.getTime())) return d
  }
  return getSlateDeadline(games)
}

export function isSlateLocked(slate: SlateLock, games: Game[], now: Date): boolean {
  const deadline = slateDeadline(slate, games)
  if (!deadline) return false
  return now >= deadline
}

// Picks become public exactly when they lock — there is nothing left to give
// away once nobody can change their pick.
export function isPickRevealed(slate: SlateLock, games: Game[], now: Date): boolean {
  return isSlateLocked(slate, games, now)
}

// The game a team plays on this slate, if any.
export function gameForTeam(team: string, games: Game[]): Game | undefined {
  return games.find((g) => g.home_team === team || g.away_team === team)
}

// Early access to the next day requires a final win, not merely a game that
// has tipped or a player row that has not yet been graded as eliminated.
export function didPickWin(pick: { slate_id: string; team: string }, games: Game[]): boolean {
  const game = games.find((g) =>
    g.slate_id === pick.slate_id && (g.home_team === pick.team || g.away_team === pick.team)
  )
  if (!game) return false
  return game.result === (game.home_team === pick.team ? 'home_win' : 'away_win')
}

// Tournament seed only. Outside the tournament ESPN's curatedRank is the AP
// poll rank, which is stored on the game for display but must never reach a
// pick's `seed` — the endgame tiebreak sums seeds, and counting a #20 AP
// ranking as a 20-seed would wreck it.
export function seedForTeam(team: string, games: Game[]): number | null {
  const game = gameForTeam(team, games)
  if (!game || !game.round_label) return null
  if (game.home_team === team) return game.home_seed
  if (game.away_team === team) return game.away_seed
  return null
}

// Auto-assign fallback, in the spirit of the NFL pool's "SNF away team, then
// MNF away team, then you're out": walk the slate from the last tip backwards
// and take the first team the player hasn't already used, away side first.
// Latest-tipping games are chosen deliberately — a player who missed the
// deadline shouldn't be handed a game that has already finished.
//
// Returns null only when every team on the slate is already spent, which is
// the one case that eliminates rather than assigns.
export function autoAssignTeam(games: Game[], usedTeams: string[]): string | null {
  const used = new Set(usedTeams)
  const byLatest = games
    .filter((g) => tipOf(g) !== null)
    .slice()
    .sort((a, b) => new Date(b.tip_time).getTime() - new Date(a.tip_time).getTime())

  for (const game of byLatest) {
    if (!used.has(game.away_team)) return game.away_team
    if (!used.has(game.home_team)) return game.home_team
  }
  return null
}

type SeedCandidate = {
  team: string
  seed: number
  apRank: number
}

// Tournament auto-pick. "Highest seed" means the strongest line in the
// bracket: No. 1 before No. 2, and so on. Once a player has used a seed value
// anywhere in the tournament, move to the next available seed value. AP rank
// breaks a tie between teams on the same line; an unranked team sorts last.
//
// If a late-round slate contains only seed values the player has already
// used, fall back to the best unused team still playing rather than eliminate
// the player for a bracket shape they cannot control.
export function autoAssignHighestSeed(
  games: Game[],
  usedTeams: string[],
  usedSeeds: number[],
  apRanks: Record<string, number>
): string | null {
  const usedTeamSet = new Set(usedTeams)
  const usedSeedSet = new Set(usedSeeds.filter((seed) => Number.isInteger(seed) && seed >= 1 && seed <= 16))
  const candidates: SeedCandidate[] = []

  for (const game of games) {
    if (!game.round_label) continue
    for (const [team, seed] of [
      [game.away_team, game.away_seed],
      [game.home_team, game.home_seed],
    ] as const) {
      if (usedTeamSet.has(team) || seed === null || seed < 1 || seed > 16) continue
      candidates.push({ team, seed, apRank: apRanks[team] ?? Number.MAX_SAFE_INTEGER })
    }
  }

  const compare = (a: SeedCandidate, b: SeedCandidate) =>
    a.seed - b.seed || a.apRank - b.apRank || a.team.localeCompare(b.team)
  const freshSeedCandidates = candidates.filter((candidate) => !usedSeedSet.has(candidate.seed)).sort(compare)
  return freshSeedCandidates[0]?.team ?? candidates.sort(compare)[0]?.team ?? null
}

// Format a UTC date as a human-readable Central time string
export function formatCentralTime(utcDate: Date | string): string {
  const d = typeof utcDate === 'string' ? new Date(utcDate) : utcDate
  return d.toLocaleString('en-US', {
    timeZone: CHICAGO_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// "Sat, Mar 21" — the label for a slate, which is now the period name.
export function formatSlateDate(slateDate: string): string {
  // slate_date is a bare YYYY-MM-DD; parse as local noon so no timezone shift
  // can roll it onto the adjacent day.
  const d = new Date(`${slateDate}T12:00:00`)
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
