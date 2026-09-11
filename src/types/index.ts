export type PlayerStatus = 'alive' | 'eliminated'
export type GameResult = 'home_win' | 'away_win' | 'tie' | 'pending'
// ESPN's status.type.state
export type GameState = 'pre' | 'in' | 'post'

export interface Player {
  id: string
  full_name: string
  phone: string | null
  email: string
  venmo_handle: string | null
  paid: boolean
  status: PlayerStatus
  elimination_slate: number | null
  elimination_reason: string | null
  created_at: string
}

// One calendar day (Central) of games — the unit of play. `locks_at` is the
// day's first tip, cached at sync time: every pick on the slate locks then.
export interface Slate {
  id: string
  slate_number: number // sequential day index within the season
  slate_date: string // YYYY-MM-DD, Central
  season_year: number
  is_active: boolean
  locks_at: string | null
  created_at: string
}

export interface Team {
  abbr: string
  display_name: string
  short_name: string | null
  logo: string | null
  conference: string | null
  updated_at: string
}

export interface Game {
  id: string
  slate_id: string
  espn_event_id: string
  home_team: string
  away_team: string
  // NCAA tournament seed. Only meaningful when `round_label` is set — outside
  // the tournament ESPN's curatedRank is the AP poll rank.
  home_seed: number | null
  away_seed: number | null
  tip_time: string // ISO, UTC
  // True while ESPN has only a placeholder time (midnight Eastern). The
  // stored tip_time is not a real tip and must not drive locks or display.
  time_tbd: boolean
  round_label: string | null // "1st Round", "Sweet 16", "Elite 8", ...
  region: string | null
  venue: string | null
  tv: string | null
  status_state: GameState
  period: number | null
  display_clock: string | null
  home_score: number | null
  away_score: number | null
  result: GameResult
  created_at: string
}

export interface Pick {
  id: string
  player_id: string
  slate_id: string
  team: string
  // Snapshotted at pick time — the endgame tiebreak sums the seeds a player
  // took, and a seed only means something on the day it was picked.
  seed: number | null
  auto_assigned: boolean
  submitted_by_admin: boolean
  created_at: string
}

export interface PlayerWithPick extends Player {
  pick?: Pick
  used_teams: string[]
  slates_survived: number
  seed_total: number
}

export interface DashboardData {
  current_slate: Slate | null
  active_players: number
  eliminated_players: number
  total_players: number
  pot_size: number
  payout_per_survivor: number
  standings: StandingRow[]
  team_stats: TeamStat[]
  next_deadline: string | null
  next_deadline_label: string | null
}

export interface StandingRow {
  player_id: string
  full_name: string
  status: PlayerStatus
  slates_survived: number
  // Sum of the seeds this player has taken — the tiebreak when more than one
  // survivor is left at the end. Higher wins: it means riskier picks.
  seed_total: number
  current_pick: string | null
  pick_locked: boolean
  // True once the slate has locked and the pick can be shown publicly.
  pick_revealed: boolean
  elimination_reason: string | null
  elimination_slate?: number | null
}

export interface TeamStat {
  team: string
  times_picked: number
  win_rate: number
  eliminations_caused: number
}

export interface SessionPayload {
  player_id: string
  full_name: string
  is_admin: boolean
  expires_at: string
  test_mode?: boolean // set when the session was created in the testing sandbox
}

// Tournament rounds and their pick quotas live in lib/competition.ts, next to
// the rest of the competition-mode system. Re-exported here so the existing
// `@/types` import path keeps working.
export {
  ROUND_SEQUENCE as TOURNAMENT_ROUNDS,
  ROUND_PICK_QUOTA,
  type TournamentRound,
} from '@/lib/competition'
