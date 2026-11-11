import 'server-only'

// ESPN men's college basketball scoreboard — the one external source for
// schedules, live scores, seeds, and final results.
//
// The feed is unofficial: no published quota, no SLA, and it caches for about
// ten seconds. That cache is the floor on useful polling — asking more often
// than every ~10s returns the same bytes. Callers pass `revalidateSeconds`
// accordingly: ~10s while games are in progress, minutes otherwise.

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard'
const RANKINGS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings'

// ESPN conference group ids. The scoreboard honours `groups`; the /teams
// endpoint does NOT (it returns the same 100 teams whatever you pass), which
// is why the team universe is discovered from game results instead.
export const CONFERENCES: Record<string, number> = {
  ACC: 2,
  'Big East': 4,
  'Big Ten': 7,
  'Big 12': 8,
  SEC: 23,
  'Pac-12': 21,
}

// Every NCAA tournament game, regardless of the participants' conference.
// Narrower than groups=50 (all of D1), which also sweeps in the College
// Basketball Crown — those events come back with curatedRank 99 and would
// pollute the seed-based tiebreak.
export const TOURNAMENT_GROUP = 100

export interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score?: string
  winner?: boolean
  curatedRank?: { current?: number }
  records?: Array<{ summary?: string }>
  team: {
    id?: string
    abbreviation?: string
    displayName?: string
    shortDisplayName?: string
    logo?: string
    color?: string
    alternateColor?: string
    logos?: Array<{ href?: string; rel?: string[] }>
  }
}

export interface EspnEvent {
  id: string
  date: string
  shortName?: string
  competitions: Array<{
    // False when ESPN has the date but not the tip time yet — a full season
    // is published months ahead with midnight-Eastern placeholders.
    timeValid?: boolean
    neutralSite?: boolean
    status: {
      // `name` is ESPN's status code (STATUS_FINAL, STATUS_POSTPONED, ...).
      type: { name?: string; state: string; detail?: string; shortDetail?: string; completed: boolean }
      displayClock?: string
      period?: number
    }
    competitors: EspnCompetitor[]
    broadcasts?: Array<{ names?: string[] }>
    venue?: { fullName?: string }
    notes?: Array<{ headline?: string }>
  }>
}

// ESPN reports an unranked team as curatedRank 99. Outside the tournament the
// value is the AP poll rank rather than a seed; callers decide whether it
// means anything by looking at `roundLabel`.
export const UNRANKED = 99

interface EspnRankingEntry {
  current?: number
  team?: { abbreviation?: string }
}

interface EspnRankingPoll {
  name?: string
  type?: string
  ranks?: EspnRankingEntry[]
}

// A small lookup used only by the tournament auto-pick tiebreak. Scoreboard
// curatedRank becomes the bracket seed in March, so AP rank must come from the
// rankings endpoint instead of being inferred from a game row.
export async function fetchApRankings(revalidateSeconds = 3600): Promise<Record<string, number>> {
  try {
    const res = await fetch(
      RANKINGS_URL,
      revalidateSeconds > 0 ? { next: { revalidate: revalidateSeconds }, signal: AbortSignal.timeout(8000) } : { cache: 'no-store', signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return {}
    const data = (await res.json()) as { rankings?: EspnRankingPoll[] }
    const poll = (data.rankings ?? []).find(
      (ranking) => ranking.type?.toLowerCase() === 'ap' || ranking.name?.toLowerCase().includes('ap top 25')
    )
    const ranks: Record<string, number> = {}
    for (const entry of poll?.ranks ?? []) {
      const team = entry.team?.abbreviation
      const rank = entry.current
      if (team && Number.isInteger(rank) && rank! >= 1 && rank! <= 25) ranks[team] = rank!
    }
    return ranks
  } catch {
    return {}
  }
}

export function seedOf(competitor: EspnCompetitor): number | null {
  const rank = competitor.curatedRank?.current
  if (rank === undefined || rank === null || rank === UNRANKED) return null
  return rank
}

async function fetchGroup(
  group: number,
  yyyymmdd: string,
  revalidateSeconds: number
): Promise<EspnEvent[] | null> {
  const url = `${SCOREBOARD_URL}?groups=${group}&dates=${yyyymmdd}&limit=200`
  try {
    const res = await fetch(
      url,
      revalidateSeconds > 0 ? { next: { revalidate: revalidateSeconds }, signal: AbortSignal.timeout(8000) } : { cache: 'no-store', signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    return (data.events ?? []) as EspnEvent[]
  } catch {
    return null
  }
}

export interface ScoreboardFetch {
  events: EspnEvent[]
  // Conferences whose call failed. A partial slate is still worth showing,
  // but the sync must not delete games it simply failed to fetch, so it needs
  // to know coverage was incomplete.
  failedGroups: string[]
}

// Fetch one day across every tracked conference plus the tournament, unioned and
// deduped by event id. Dedupe is load-bearing: a non-conference matchup (say
// Big Ten vs SEC) is returned by both of those calls, and the tournament
// group overlaps every conference once March arrives.
export async function fetchDayScoreboard(
  yyyymmdd: string,
  revalidateSeconds = 0
): Promise<ScoreboardFetch> {
  const groups: Array<[string, number]> = [
    ...Object.entries(CONFERENCES),
    ['Tournament', TOURNAMENT_GROUP],
  ]

  const results = await Promise.all(
    groups.map(async ([name, group]) => ({
      name,
      events: await fetchGroup(group, yyyymmdd, revalidateSeconds),
    }))
  )

  const byId = new Map<string, EspnEvent>()
  const failedGroups: string[] = []
  for (const { name, events } of results) {
    if (events === null) {
      failedGroups.push(name)
      continue
    }
    for (const event of events) {
      // First writer wins; the payload is identical across groups, and
      // overwriting would only churn.
      if (!byId.has(event.id)) byId.set(event.id, event)
    }
  }

  const events = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date))
  return { events, failedGroups }
}

export function eventCompetitors(
  event: EspnEvent
): { home: EspnCompetitor; away: EspnCompetitor } | null {
  const comp = event.competitions?.[0]
  if (!comp) return null
  const home = comp.competitors?.find((c) => c.homeAway === 'home')
  const away = comp.competitors?.find((c) => c.homeAway === 'away')
  return home && away ? { home, away } : null
}

// Pair an ESPN event with the stored game it was matched to by event id, and
// return its competitors in the stored orientation. A side matches on ESPN's
// stable team id when both the stored row and the feed carry one, and on the
// abbreviation only for legacy rows without ids. A neutral-site event ESPN
// lists the other way round is flipped back. Null when the teams differ —
// the board then shows the stored schedule rather than someone else's game.
export function scheduledEventSides(
  stored: { home_team: string; away_team: string; home_team_id?: string | null; away_team_id?: string | null },
  event: EspnEvent
): { home: EspnCompetitor; away: EspnCompetitor; flipped: boolean } | null {
  const teams = eventCompetitors(event)
  if (!teams?.home.team.abbreviation || !teams.away.team.abbreviation) return null
  const is = (abbr: string, id: string | null | undefined, side: EspnCompetitor) =>
    id && side.team.id ? id === side.team.id : abbr === side.team.abbreviation
  if (is(stored.home_team, stored.home_team_id, teams.home) && is(stored.away_team, stored.away_team_id, teams.away)) {
    return { home: teams.home, away: teams.away, flipped: false }
  }
  if (event.competitions[0].neutralSite === true &&
      is(stored.home_team, stored.home_team_id, teams.away) && is(stored.away_team, stored.away_team_id, teams.home)) {
    return { home: teams.away, away: teams.home, flipped: true }
  }
  return null
}

export interface RoundInfo {
  roundLabel: string | null
  region: string | null
}

// ESPN encodes the bracket position in a single note headline, e.g.
// "NCAA Men's Basketball Championship - East Region - Sweet 16". Split it
// into region and round; anything that isn't an NCAA tournament note (the
// Crown, conference tournaments, plain regular season) yields nulls.
export function parseRound(event: EspnEvent): RoundInfo {
  const headline = event.competitions?.[0]?.notes?.[0]?.headline
  if (!headline || !/NCAA Men's Basketball Championship/i.test(headline)) {
    return { roundLabel: null, region: null }
  }
  const parts = headline.split(' - ').map((p) => p.trim())
  const region = parts.find((p) => /Region$/i.test(p))?.replace(/\s*Region$/i, '') ?? null
  const roundLabel = parts[parts.length - 1] ?? null
  return { roundLabel, region }
}

export function broadcastOf(event: EspnEvent): string | null {
  const names = (event.competitions?.[0]?.broadcasts ?? []).flatMap((b) => b.names ?? [])
  return names.length > 0 ? names.join(', ') : null
}

// ESPN status codes that mean the game is over and the score stands. Overtime
// finals keep STATUS_FINAL (the detail reads "Final/OT"); STATUS_FINAL_OT is
// what ESPN uses for the same thing in other sports. Every other code —
// STATUS_POSTPONED, STATUS_CANCELED, STATUS_SUSPENDED, STATUS_FORFEIT,
// STATUS_DELAYED, STATUS_ABANDONED, a missing code, or one ESPN adds later —
// is treated as unresolved, never as a result.
const FINAL_STATUS_NAMES = new Set(['STATUS_FINAL', 'STATUS_FINAL_OT'])

function finalScore(competitor: EspnCompetitor): number | null {
  const raw = typeof competitor.score === 'string' ? competitor.score.trim() : ''
  return /^\d+$/.test(raw) ? Number(raw) : null
}

function sameTeam(a: EspnCompetitor, b: EspnCompetitor): boolean {
  if (a.team.id && b.team.id) return a.team.id === b.team.id
  return a.team.abbreviation === b.team.abbreviation
}

// Translate ESPN's status into the stored result. A game is graded only when
// ESPN calls it final, both sides are identified, both final scores are
// present and unequal, and any winner flag agrees with the scores. Anything
// else — postponed, cancelled, suspended, a 0–0 placeholder, a missing score,
// a flag contradicting the score — stays 'pending' for an organizer to
// resolve. A college game cannot end in a tie (it goes to overtime), so equal
// scores are an unresolved feed, not a tie: 'tie' is never written here.
export function resultOf(
  event: EspnEvent
): 'home_win' | 'away_win' | 'pending' {
  const type = event.competitions?.[0]?.status?.type
  if (!type || type.completed !== true || type.state !== 'post') return 'pending'
  if (!type.name || !FINAL_STATUS_NAMES.has(type.name)) return 'pending'
  // Exactly two competitors, one home and one away. A third entry means the
  // feed is not describing a plain two-team game, so nothing is graded.
  const competitors = event.competitions[0].competitors ?? []
  if (competitors.length !== 2 || competitors.filter((c) => c.homeAway === 'home').length !== 1 ||
      competitors.filter((c) => c.homeAway === 'away').length !== 1) return 'pending'
  const teams = eventCompetitors(event)
  if (!teams) return 'pending'
  const { home, away } = teams
  if (!home.team?.abbreviation || !away.team?.abbreviation || sameTeam(home, away)) return 'pending'
  const homeScore = finalScore(home)
  const awayScore = finalScore(away)
  if (homeScore === null || awayScore === null || homeScore === awayScore) return 'pending'
  const scored: 'home' | 'away' = homeScore > awayScore ? 'home' : 'away'
  const flagged = [home.winner === true ? 'home' : null, away.winner === true ? 'away' : null].filter(Boolean)
  // Both flagged, or one flagged against the score, is a feed error.
  if (flagged.length > 1 || (flagged.length === 1 && flagged[0] !== scored)) return 'pending'
  // A side explicitly marked as not winning cannot be the higher score.
  if ((scored === 'home' ? home.winner : away.winner) === false) return 'pending'
  return scored === 'home' ? 'home_win' : 'away_win'
}

// The state a board may show. ESPN reports postponed and cancelled games as
// 'post' with a 0–0 score, and every board reads 'post' as "final, compare
// the scores" — which would show both sides as having lost. Only a game with
// a definitive result is 'post' here; an unresolved one shows as not started,
// with ESPN's own status text ("Postponed") left for the caller to display.
export function displayStateOf(event: EspnEvent): 'pre' | 'in' | 'post' {
  const state = event.competitions?.[0]?.status?.type?.state
  if (state === 'in') return 'in'
  if (state === 'post' && resultOf(event) !== 'pending') return 'post'
  return 'pre'
}

// Whether ESPN has actually announced this tip time. A placeholder event
// carries `timeValid: false` and a status of TBD, and its `date` is midnight
// Eastern — which is the previous day in Central, and no kind of tip time at
// all. Callers must not treat it as one.
export function isTimeTbd(event: EspnEvent): boolean {
  return event.competitions?.[0]?.timeValid === false
}

// YYYYMMDD in Central time — the parameter ESPN's `dates` expects, and the
// key the app groups a slate by.
export function toEspnDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return parts.replace(/-/g, '')
}

// The ISO date (YYYY-MM-DD) of a timestamp in Central time. ESPN's `dates`
// parameter is not a strict calendar filter — asking for 20260326 also
// returns games that tip after midnight ET on the 27th — so a game's slate is
// decided by its own tip time, not by which query returned it.
export function centralDateOf(utcIso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(utcIso))
}

// The ISO date (YYYY-MM-DD) of a timestamp in Eastern time. Used only for
// games with a placeholder tip: the placeholder is midnight Eastern on the
// day the game is actually meant to be played, so its Eastern date is the
// right slate even though its Central date is the day before.
export function easternDateOf(utcIso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(utcIso))
}
