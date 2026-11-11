// Final standings of a finished contest, built from contest_history() output
// (migration 030). Pure so it can be unit tested; no database access here.

export interface HistoryEntry {
  id: string
  full_name: string
  status: string
  elimination_slate: number | null
  elimination_reason: string | null
}
export interface HistoryPick {
  player_id: string
  slate_id: string
  team: string
  seed: number | null
  loss_excused: boolean
  auto_assigned: boolean
}
export interface HistorySlate { id: string; slate_number: number; slate_date: string }
export interface HistoryGame { slate_id: string; home_team: string; away_team: string; result: string; round_label: string | null }
export interface ContestHistory {
  source: 'live' | 'archive'
  pool: { id: string; name: string; competition_mode: string; status: string; season_year: number; starts_on: string | null; ended_on: string | null }
  entries: HistoryEntry[]
  picks: HistoryPick[]
  slates: HistorySlate[]
  games: HistoryGame[]
}

export type HistoryOutcome = 'won' | 'lost' | 'pending'
export interface HistoryRow {
  id: string
  name: string
  status: string
  wins: number
  seedTotal: number
  eliminationSlate: number | null
  eliminationReason: string | null
  bySlate: Record<string, { team: string; outcome: HistoryOutcome; auto: boolean }[]>
}

export function pickOutcome(pick: Pick<HistoryPick, 'slate_id' | 'team' | 'loss_excused'>, games: HistoryGame[]): HistoryOutcome {
  const game = games.find((g) => g.slate_id === pick.slate_id && (g.home_team === pick.team || g.away_team === pick.team))
  if (!game || game.result === 'pending') return 'pending'
  if (game.result === 'home_win') return game.home_team === pick.team ? 'won' : pick.loss_excused ? 'pending' : 'lost'
  if (game.result === 'away_win') return game.away_team === pick.team ? 'won' : pick.loss_excused ? 'pending' : 'lost'
  return pick.loss_excused ? 'pending' : 'lost'
}

// Alive entries first, then by winning picks, then the later elimination, then name.
export function buildHistoryRows(history: Pick<ContestHistory, 'entries' | 'picks' | 'games'>): HistoryRow[] {
  const rows = history.entries.map((entry): HistoryRow => ({
    id: entry.id,
    name: entry.full_name,
    status: entry.status,
    wins: 0,
    seedTotal: 0,
    eliminationSlate: entry.elimination_slate,
    eliminationReason: entry.elimination_reason,
    bySlate: {},
  }))
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const pick of history.picks) {
    const row = byId.get(pick.player_id)
    if (!row) continue
    const outcome = pickOutcome(pick, history.games)
    if (outcome === 'won') row.wins++
    row.seedTotal += pick.seed ?? 0
    ;(row.bySlate[pick.slate_id] ??= []).push({ team: pick.team, outcome, auto: pick.auto_assigned })
  }
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
    if (b.wins !== a.wins) return b.wins - a.wins
    if ((b.eliminationSlate ?? 0) !== (a.eliminationSlate ?? 0)) return (b.eliminationSlate ?? 0) - (a.eliminationSlate ?? 0)
    return a.name.localeCompare(b.name)
  })
}
