// The competition-mode system.
//
// MADNESS runs two competitions off one survivor engine: a regular-season
// college basketball pool and an NCAA tournament pool. They share every rule
// that matters — one pick per pick period, no team twice, a loss ends you —
// and differ only in what the product should *show* and *call things*.
//
// This module is the single place that difference is described. The rest of
// the app asks it questions ("does this pool show seeds?", "what do I call a
// pick period?") instead of testing the mode inline. Nothing here touches the
// database or the clock, so both server and client components can import it.

export type CompetitionMode = 'regular-season' | 'march-madness'

export const COMPETITION_MODES: CompetitionMode[] = ['regular-season', 'march-madness']

// Where a pool sits in its own lifecycle. Deliberately separate from the
// mode: a march-madness pool is 'upcoming' until Selection Sunday, and a
// regular-season pool is 'live' in January.
export type PoolStatus = 'draft' | 'upcoming' | 'open' | 'live' | 'completed' | 'archived'

export const POOL_STATUSES: PoolStatus[] = [
  'draft',
  'upcoming',
  'open',
  'live',
  'completed',
  'archived',
]

export type PickFrequency = 'every-game-day' | 'weekends-only' | 'tournament-round'
export type PickDeadlineRule = 'first-tip' | 'per-game'
export type TeamReuseRule = 'once-per-pool' | 'once-per-round' | 'unlimited'
export type AutoPickBehavior = 'latest-game' | 'eliminate' | 'none'
export type Tiebreaker = 'seed-total' | 'most-survived' | 'none'

export interface PoolConfig {
  id: string
  name: string
  competition_mode: CompetitionMode
  status: PoolStatus
  season_year: number
  pick_frequency: PickFrequency
  pick_deadline_rule: PickDeadlineRule
  team_reuse_rule: TeamReuseRule
  auto_pick_behavior: AutoPickBehavior
  tiebreaker: Tiebreaker
  starts_on: string | null
  is_active: boolean
  created_at?: string
  updated_at?: string
}

// ---------------------------------------------------------------- capabilities

// What the active competition supports. The UI reads these rather than
// re-deciding "are we in the tournament" at every call site — that is how a
// two-mode product turns into a thousand scattered conditionals.
export interface CompetitionCapabilities {
  showSeeds: boolean
  showRegions: boolean
  showTournamentRounds: boolean
  groupScheduleByRound: boolean
  // A masthead that names the round and counts the field, rather than the date.
  showTournamentHeader: boolean
  // Pick history keyed by round rather than by calendar date.
  labelPicksByRound: boolean
  // AP poll position is meaningful outside the bracket; seed replaces it inside.
  showPollRank: boolean
  // Seeds are summed for the endgame tiebreak, which only exists in a bracket.
  showSeedTotal: boolean
}

export const COMPETITION_CAPABILITIES: Record<CompetitionMode, CompetitionCapabilities> = {
  'regular-season': {
    showSeeds: false,
    showRegions: false,
    showTournamentRounds: false,
    groupScheduleByRound: false,
    showTournamentHeader: false,
    labelPicksByRound: false,
    showPollRank: true,
    showSeedTotal: false,
  },
  'march-madness': {
    showSeeds: true,
    showRegions: true,
    showTournamentRounds: true,
    groupScheduleByRound: true,
    showTournamentHeader: true,
    labelPicksByRound: true,
    showPollRank: false,
    showSeedTotal: true,
  },
}

export function capabilitiesFor(mode: CompetitionMode): CompetitionCapabilities {
  return COMPETITION_CAPABILITIES[mode] ?? COMPETITION_CAPABILITIES['regular-season']
}

// ---------------------------------------------------------------------- copy

// Terminology. MADNESS is the brand year-round; only the supporting line and
// the nouns move. Nothing here ever renders the permanent navigation as
// "March Madness Survivor" — the site operates in January too.
export interface CompetitionCopy {
  // Sits under the wordmark. The brand itself never changes.
  tagline: string
  // What one pick period is called, when it has to be named at all.
  periodNoun: string
  // Heading over the day's games on the pick page.
  pickHeading: string
  // Heading of the schedule page.
  scheduleHeading: string
  // One line describing the format, shown in admin and in the rules block.
  blurb: string
  // The no-repeat rule, phrased for this competition.
  reuseRule: string
  // The endgame, phrased for this competition.
  endgameRule: string
}

export const COMPETITION_COPY: Record<CompetitionMode, CompetitionCopy> = {
  'regular-season': {
    tagline: 'College Basketball Survivor',
    periodNoun: 'Game Day',
    pickHeading: "Today's Games",
    scheduleHeading: 'Schedule',
    blurb:
      'Players make survivor selections from configured NCAA basketball game days throughout the season.',
    reuseRule: "You can't pick the same team twice all season.",
    endgameRule: 'Last one standing wins.',
  },
  'march-madness': {
    tagline: 'Tournament Survivor',
    periodNoun: 'Round',
    pickHeading: "Today's Tournament Games",
    scheduleHeading: 'Tournament Schedule',
    blurb:
      'Enables NCAA Tournament rounds, seeds, tournament-specific scheduling, bracket context, and March Madness terminology.',
    reuseRule: "You can't pick the same team twice in the tournament.",
    endgameRule:
      'Last one standing wins. If more than one survives, the highest total of seeds picked takes it.',
  },
}

export function copyFor(mode: CompetitionMode): CompetitionCopy {
  return COMPETITION_COPY[mode] ?? COMPETITION_COPY['regular-season']
}

export const MODE_LABEL: Record<CompetitionMode, string> = {
  'regular-season': 'Regular Season',
  'march-madness': 'March Madness',
}

export const STATUS_LABEL: Record<PoolStatus, string> = {
  draft: 'Draft',
  upcoming: 'Upcoming',
  open: 'Open',
  live: 'Live',
  completed: 'Completed',
  archived: 'Archived',
}

// -------------------------------------------------------------------- rounds

// Bracket order. The keys are ESPN's own note headlines, because that is what
// lands in games.round_label; the display names are what a fan calls them.
export const ROUND_SEQUENCE = [
  'First Four',
  '1st Round',
  '2nd Round',
  'Sweet 16',
  'Elite 8',
  'Final Four',
  'National Championship',
] as const

export type TournamentRound = (typeof ROUND_SEQUENCE)[number]

export const ROUND_DISPLAY: Record<TournamentRound, string> = {
  'First Four': 'First Four',
  '1st Round': 'First Round',
  '2nd Round': 'Second Round',
  'Sweet 16': 'Sweet 16',
  'Elite 8': 'Elite Eight',
  'Final Four': 'Final Four',
  'National Championship': 'National Championship',
}

// ESPN has not been consistent about these headlines across seasons, and an
// admin entering a game by hand will type whatever they call it. Normalising
// here keeps every downstream grouping — schedule tabs, pick history, the
// sweat board — working off one vocabulary.
const ROUND_ALIASES: Record<string, TournamentRound> = {
  'first four': 'First Four',
  'opening round': 'First Four',
  '1st round': '1st Round',
  'first round': '1st Round',
  'round of 64': '1st Round',
  '2nd round': '2nd Round',
  'second round': '2nd Round',
  'round of 32': '2nd Round',
  'sweet 16': 'Sweet 16',
  'sweet sixteen': 'Sweet 16',
  'regional semifinal': 'Sweet 16',
  'elite 8': 'Elite 8',
  'elite eight': 'Elite 8',
  'regional final': 'Elite 8',
  'final four': 'Final Four',
  'national semifinal': 'Final Four',
  'national championship': 'National Championship',
  championship: 'National Championship',
  'championship game': 'National Championship',
}

// Map a stored round_label onto the canonical round, or null when the game
// isn't a tournament game at all.
export function normalizeRound(label: string | null | undefined): TournamentRound | null {
  if (!label) return null
  return ROUND_ALIASES[label.trim().toLowerCase()] ?? null
}

export function roundDisplay(label: string | null | undefined): string | null {
  const round = normalizeRound(label)
  return round ? ROUND_DISPLAY[round] : null
}

export function roundOrder(round: TournamentRound | null): number {
  if (!round) return ROUND_SEQUENCE.length
  const i = ROUND_SEQUENCE.indexOf(round)
  return i === -1 ? ROUND_SEQUENCE.length : i
}

// How many picks a player spends in each round. Outside the tournament the
// rule is one pick per slate; inside it the quota belongs to the round and
// can be spent across that round's days however the player likes.
export const ROUND_PICK_QUOTA: Record<TournamentRound, number> = {
  'First Four': 1,
  '1st Round': 2,
  '2nd Round': 2,
  'Sweet 16': 2,
  'Elite 8': 2,
  'Final Four': 1,
  'National Championship': 1,
}

// A round quota can be spent on either playing day. Elite Eight always uses
// this rule: two picks across the complete round, never one forced pick per
// calendar day. Pools configured for tournament-round frequency use the same
// round-level model for every bracket round.
export function sharedRoundPickQuota(
  mode: CompetitionMode,
  frequency: PickFrequency,
  round: TournamentRound | null
): number | null {
  if (mode !== 'march-madness' || !round) return null
  if (round === 'Elite 8' || frequency === 'tournament-round') {
    return ROUND_PICK_QUOTA[round]
  }
  return null
}

// ------------------------------------------------------------- pick periods

// A pick period is the set of games a player may choose from for one required
// selection. It is the abstraction that keeps survivor logic from being tied
// to "weeks" (which college basketball does not have) or to tournament rounds
// (which only exist in March).
//
//   Regular season:  Saturday, January 24  · 10 eligible games · Lock 11:00 AM
//   March Madness:   First Round · Thursday · 16 eligible games · Lock 11:15 AM
//
// Players rarely see the term. They see the label.
export interface PickPeriodSource {
  id: string
  slate_number: number
  slate_date: string
  locks_at?: string | null
}

export interface PickPeriodGame {
  slate_id: string
  round_label?: string | null
}

export interface PickPeriod {
  id: string
  /** Sequential day index within the season — "Game Day 12". */
  number: number
  /** YYYY-MM-DD, Central. */
  date: string
  /** The primary line: "Saturday, January 24" or "First Round · Day 1". */
  label: string
  /** The tight version for table headers and chips: "Jan 24" / "R1 · D1". */
  shortLabel: string
  /** Canonical round, in march-madness mode only. */
  round: TournamentRound | null
  roundLabel: string | null
  /** 1-based index of this day within its round ("First Round · Day 2"). */
  dayInRound: number | null
  locksAt: string | null
}

const WEEKDAY_LONG: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

// slate_date is a bare YYYY-MM-DD; parse at local noon so no timezone shift
// can roll it onto the adjacent day.
function dateOf(slateDate: string): Date {
  return new Date(`${String(slateDate).slice(0, 10)}T12:00:00`)
}

export function formatPeriodDate(slateDate: string): string {
  return dateOf(slateDate).toLocaleDateString('en-US', WEEKDAY_LONG)
}

export function formatPeriodDateShort(slateDate: string): string {
  return dateOf(slateDate).toLocaleDateString('en-US', MONTH_DAY)
}

export function weekdayOf(slateDate: string): string {
  return dateOf(slateDate).toLocaleDateString('en-US', { weekday: 'long' })
}

// The round a day belongs to: the round most of its games carry. A day that
// straddles two rounds (rare, but the First Four does it) takes the earlier
// one, which is the one players are still picking from.
function roundForSlate(slateId: string, games: PickPeriodGame[]): TournamentRound | null {
  const counts = new Map<TournamentRound, number>()
  for (const g of games) {
    if (g.slate_id !== slateId) continue
    const round = normalizeRound(g.round_label)
    if (!round) continue
    counts.set(round, (counts.get(round) ?? 0) + 1)
  }
  let best: TournamentRound | null = null
  for (const [round, count] of counts) {
    if (!best) { best = round; continue }
    const bestCount = counts.get(best) ?? 0
    if (count > bestCount || (count === bestCount && roundOrder(round) < roundOrder(best))) {
      best = round
    }
  }
  return best
}

// Derive every pick period for a season, in calendar order. Pure over rows
// the caller already has in hand.
export function buildPickPeriods(
  mode: CompetitionMode,
  slates: PickPeriodSource[],
  games: PickPeriodGame[]
): PickPeriod[] {
  const ordered = [...slates].sort((a, b) => a.slate_date.localeCompare(b.slate_date))
  const tournament = capabilitiesFor(mode).showTournamentRounds

  const seenInRound = new Map<TournamentRound, number>()

  return ordered.map((slate) => {
    const round = tournament ? roundForSlate(slate.id, games) : null
    let dayInRound: number | null = null
    if (round) {
      dayInRound = (seenInRound.get(round) ?? 0) + 1
      seenInRound.set(round, dayInRound)
    }

    const display = round ? ROUND_DISPLAY[round] : null
    const weekday = weekdayOf(slate.slate_date)

    // In the tournament the round is the headline and the day is the detail.
    // A round with one playing day doesn't need a day number at all.
    const label = display
      ? `${display} · ${weekday}`
      : formatPeriodDate(slate.slate_date)
    const shortLabel = display
      ? `${shortRound(round!)}${dayInRound && dayInRound > 1 ? ` · D${dayInRound}` : ''}`
      : formatPeriodDateShort(slate.slate_date)

    return {
      id: slate.id,
      number: slate.slate_number,
      date: String(slate.slate_date).slice(0, 10),
      label,
      shortLabel,
      round,
      roundLabel: display,
      dayInRound,
      locksAt: slate.locks_at ?? null,
    }
  })
}

const SHORT_ROUND: Record<TournamentRound, string> = {
  'First Four': 'FF4',
  '1st Round': 'R64',
  '2nd Round': 'R32',
  'Sweet 16': 'S16',
  'Elite 8': 'E8',
  'Final Four': 'F4',
  'National Championship': 'NCG',
}

export function shortRound(round: TournamentRound): string {
  return SHORT_ROUND[round]
}

// ------------------------------------------------- round of 64 countdown

const CENTRAL_TZ = 'America/Chicago'
const MARCH = 2
const THURSDAY = 4
const MS_PER_DAY = 86_400_000

// The Round of 64 — the bracket's first full round, and the day this pool
// really begins — tips on the third Thursday of March. That has held for every
// tournament the committee has scheduled (Mar 16 2023, Mar 21 2024, Mar 20
// 2025, Mar 19 2026, Mar 18 2027, Mar 16 2028), so the date is derived rather
// than kept as a table someone has to remember to extend.
//
// Returned at noon UTC: the countdown only ever reads the calendar date off
// it, and noon keeps that date the same in every timezone it gets formatted in.
export function roundOf64Date(tournamentYear: number): Date {
  const marchFirst = new Date(Date.UTC(tournamentYear, MARCH, 1, 12))
  const daysToFirstThursday = (THURSDAY - marchFirst.getUTCDay() + 7) % 7
  return new Date(Date.UTC(tournamentYear, MARCH, 1 + daysToFirstThursday + 14, 12))
}

export interface RoundOf64Countdown {
  /** Whole days from today (Central) until the Round of 64. 0 means today. */
  days: number
  /** "March 18, 2027" */
  dateLabel: string
  /** The calendar year the countdown is pointing at. */
  year: number
}

// Today's date in Central time, as noon UTC — the same shape roundOf64Date
// returns, so subtracting the two gives whole days with no DST remainder.
function centralToday(now: Date): Date {
  const [year, month, day] = now
    .toLocaleDateString('en-CA', { timeZone: CENTRAL_TZ })
    .split('-')
    .map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12))
}

// How long until the round of 64 tips. `seasonYear` is the pool's own season
// (a 2027 season plays its tournament in March 2027); once that tournament is
// behind us the countdown rolls to the next one rather than going negative.
export function roundOf64Countdown(now: Date, seasonYear?: number | null): RoundOf64Countdown {
  const today = centralToday(now)
  let year = seasonYear ?? today.getUTCFullYear()
  let tipoff = roundOf64Date(year)
  while (tipoff.getTime() < today.getTime()) {
    year += 1
    tipoff = roundOf64Date(year)
  }

  return {
    days: Math.round((tipoff.getTime() - today.getTime()) / MS_PER_DAY),
    dateLabel: tipoff.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    year,
  }
}

// Seed only means something inside a bracket. Outside it, ESPN's curatedRank
// is the AP poll position, and rendering a #20 team as a 20-seed would be a
// lie the tiebreak would then compound.
export function seedToShow(
  mode: CompetitionMode,
  seed: number | null | undefined,
  roundLabel: string | null | undefined
): number | null {
  if (!capabilitiesFor(mode).showSeeds) return null
  if (!normalizeRound(roundLabel)) return null
  if (seed == null || seed < 1 || seed > 16) return null
  return seed
}
