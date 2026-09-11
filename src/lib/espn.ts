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

// ESPN conference group ids. The scoreboard honours `groups`; the /teams
// endpoint does NOT (it returns the same 100 teams whatever you pass), which
// is why the team universe is discovered from game results instead.
export const CONFERENCES: Record<string, number> = {
  ACC: 2,
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
    abbreviation?: string
    displayName?: string
    shortDisplayName?: string
    logo?: string
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
    status: {
      type: { state: string; shortDetail?: string; completed: boolean }
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
      revalidateSeconds > 0 ? { next: { revalidate: revalidateSeconds } } : { cache: 'no-store' }
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

// Fetch one day across all five conferences plus the tournament, unioned and
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

// Translate ESPN's status into the stored result. A college game cannot end
// in a tie (it goes to overtime), so 'tie' exists in the column only as a
// carry-over from the NFL schema and is never written here.
export function resultOf(
  event: EspnEvent
): 'home_win' | 'away_win' | 'pending' {
  const comp = event.competitions?.[0]
  if (!comp?.status?.type?.completed) return 'pending'
  const teams = eventCompetitors(event)
  if (!teams) return 'pending'
  if (teams.home.winner) return 'home_win'
  if (teams.away.winner) return 'away_win'
  // Completed but no winner flag — fall back to the scores.
  const homeScore = Number(teams.home.score ?? NaN)
  const awayScore = Number(teams.away.score ?? NaN)
  if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) return 'pending'
  return homeScore > awayScore ? 'home_win' : 'away_win'
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
