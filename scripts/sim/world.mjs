// A scripted 64-team tournament and the fake ESPN scoreboard that describes it.
// The calendar slides: the day being played is always "today" (Central), earlier days
// lie in the past and later days in the future, so the real clock and the app's own
// date rules (3 AM turnover, lock, "next day") apply unchanged.
import { addDays, centralDate, centralInstant, rows, sql, writeEspn } from './lib.mjs'

export const REGIONS = ['East', 'West', 'South', 'Midwest']
const LETTER = { East: 'E', West: 'W', South: 'S', Midwest: 'M' }
const R1_ORDER = [[1, 16], [8, 9], [5, 12], [4, 13], [6, 11], [3, 14], [7, 10], [2, 15]]
export const ROUNDS = ['1st Round', '2nd Round', 'Sweet 16', 'Elite 8', 'Final Four', 'National Championship']
export const DAYS = [
  { round: 0 }, { round: 0 }, { round: 1 }, { round: 1 }, { round: 2 }, { round: 2 }, { round: 3 }, { round: 3 }, { round: 4 }, { round: 5 },
]
export const QUOTA = [2, 2, 2, 2, 1, 1]
export const ROUND_LABEL_DAYS = [[0, 1], [2, 3], [4, 5], [6, 7], [8], [9]]

let seedState = 20260319
export const rand = () => { seedState = (seedState * 1664525 + 1013904223) % 4294967296; return seedState / 4294967296 }
export const reseed = (n) => { seedState = n }

let teamId = 2000
const teams = {}
export function team(region, seed) {
  const abbr = `${LETTER[region]}${String(seed).padStart(2, '0')}`
  return (teams[abbr] ??= { abbr, id: String(teamId++), seed, region, name: `${region} ${seed}` })
}
export const allTeams = () => Object.values(teams)

// Which special storyline a game carries (all in round one, day one).
export const SCRIPT = {
  'R1-E-1': 'overtime',   // 8 beats 9 in overtime
  'R1-W-1': 'postponed',  // postponed 0-0; the organizer voids it
  'R1-S-1': 'corrected',  // first reported 8 over 9, then corrected to 9 over 8
  'R1-M-1': 'flip',       // 8, then 9, then 8 again
  'R1-E-2': 'manual',     // the feed says 5 wins; the organizer enters 12
}

export const games = [] // every game, in bracket order

function mk(key, round, region, k, day, home, away) {
  const game = { key, round, region, k, day, home, away, truth: null, feed: 'pre', scoreHome: 0, scoreAway: 0, id: null }
  games.push(game)
  return game
}

export function buildR1() {
  for (const region of REGIONS) {
    R1_ORDER.forEach(([a, b], k) => mk(`R1-${LETTER[region]}-${k}`, 0, region, k, k < 4 ? 0 : 1, team(region, a), team(region, b)))
  }
}

const winnerTeam = (game) => (game.truth === 'home' ? game.home : game.away)
// P(better seed wins) rises with the gap between seeds.
export function decide(game) {
  const script = SCRIPT[game.key]
  if (script === 'overtime') return 'home'
  if (script === 'postponed') return 'home' // the advancing team once replayed outside the app
  if (script === 'corrected') return 'away'
  if (script === 'flip') return 'home'
  if (script === 'manual') return 'away'
  const gap = game.away.seed - game.home.seed
  const p = Math.min(0.97, Math.max(0.03, 0.5 + 0.034 * gap))
  return rand() < p ? 'home' : 'away'
}

export const gamesOfDay = (day) => games.filter((g) => g.day === day)
export const gamesOfRound = (round) => games.filter((g) => g.round === round)

// Build the games of a round from the winners of the previous one.
export function buildRound(round) {
  const prev = games.filter((g) => g.round === round - 1)
  if (round === 1) {
    for (const region of REGIONS) {
      const mine = prev.filter((g) => g.region === region)
      for (let k = 0; k < 4; k++) mk(`R2-${LETTER[region]}-${k}`, 1, region, k, k < 2 ? 2 : 3, winnerTeam(mine[2 * k]), winnerTeam(mine[2 * k + 1]))
    }
  } else if (round === 2) {
    for (const region of REGIONS) {
      const mine = prev.filter((g) => g.region === region)
      for (let k = 0; k < 2; k++) mk(`R3-${LETTER[region]}-${k}`, 2, region, k, k === 0 ? 4 : 5, winnerTeam(mine[2 * k]), winnerTeam(mine[2 * k + 1]))
    }
  } else if (round === 3) {
    REGIONS.forEach((region, i) => {
      const mine = prev.filter((g) => g.region === region)
      mk(`R4-${LETTER[region]}-0`, 3, region, 0, i < 2 ? 6 : 7, winnerTeam(mine[0]), winnerTeam(mine[1]))
    })
  } else if (round === 4) {
    mk('R5-0', 4, null, 0, 8, winnerTeam(prev[0]), winnerTeam(prev[1]))
    mk('R5-1', 4, null, 1, 8, winnerTeam(prev[2]), winnerTeam(prev[3]))
  } else if (round === 5) {
    mk('R6-0', 5, null, 0, 9, winnerTeam(prev[0]), winnerTeam(prev[1]))
  }
}

export const headline = (game) => game.region
  ? `NCAA Men's Basketball Championship - ${game.region} Region - ${ROUNDS[game.round]}`
  : `NCAA Men's Basketball Championship - ${ROUNDS[game.round]}`

// ESPN's wire shape for one game at its current feed state.
function side(homeAway, t, score, winner) {
  return { homeAway, score, winner, curatedRank: { current: t.seed }, records: [], team: { id: t.id, abbreviation: t.abbr, displayName: t.abbr, shortDisplayName: t.abbr } }
}
export function eventOf(game, tipIso) {
  const f = game.feed
  const type = f === 'pre' ? { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '8:00 PM' }
    : f === 'in' ? { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: '2nd Half' }
      : f === 'postponed' ? { name: 'STATUS_POSTPONED', state: 'post', completed: false, shortDetail: 'Postponed' }
        : { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: f === 'final-ot' ? 'Final/OT' : 'Final' }
  const final = f === 'final' || f === 'final-ot'
  const hs = game.scoreHome, as = game.scoreAway
  return {
    id: game.espnId, date: tipIso, shortName: `${game.away.abbr} @ ${game.home.abbr}`,
    competitions: [{ timeValid: true, neutralSite: true, status: { type, displayClock: f === 'in' ? '4:12' : '0.0', period: f === 'pre' ? 0 : 2 },
      competitors: [side('home', game.home, f === 'pre' ? undefined : String(hs), final ? hs > as : undefined),
        side('away', game.away, f === 'pre' ? undefined : String(as), final ? as > hs : undefined)],
      notes: [{ headline: headline(game) }], venue: { fullName: 'Sim Arena' }, broadcasts: [{ names: ['CBS'] }] }],
  }
}

let eventCounter = 7000
export function assignIds() { for (const g of games) g.espnId ??= String(eventCounter++) }

// Set the feed to a finished game.
export function setFinal(game, winner /* 'home' | 'away' */, ot = false) {
  game.feed = ot ? 'final-ot' : 'final'
  const margin = 3 + Math.floor(rand() * 15)
  const base = 58 + Math.floor(rand() * 20)
  game.scoreHome = winner === 'home' ? base + margin : base
  game.scoreAway = winner === 'away' ? base + margin : base
  if (ot) { game.scoreHome = winner === 'home' ? 74 : 71; game.scoreAway = winner === 'away' ? 74 : 71 }
}

// ---------------------------------------------------------------- calendar
export const sim = { current: 0, phase: 'pre', today: null, rankings: {} }

export function tipOf(game, day, current, phase, now = new Date()) {
  const date = addDays(sim.today, day - current)
  const index = gamesOfDay(day).indexOf(game)
  if (day === current && phase === 'pre') return new Date(now.getTime() + 15 * 60e3 + index * 60e3)
  if (day === current) return new Date(centralInstant(date, '00:30').getTime() + index * 300e3)
  return new Date(centralInstant(date, '18:00').getTime() + index * 600e3)
}

// Write the fake ESPN scoreboard and move the stored slates, games and tip times to
// match. Direct SQL (replica role) is the only way to slide a calendar; app code and
// the schedule itself are untouched.
// The app decides whether a two-day round is on its final day from the WEEKDAY of the stored slate date
// (src/lib/competition.ts ROUND_OPENING_WEEKDAY: 1st Round and Sweet 16 open Thursday, 2nd Round and Elite 8 open
// Saturday). The sim plays every day on today's real date, so on a Thursday or Saturday the second day would look like
// an opening day and the lock-time assignment would (correctly, for a real calendar) wait for a day that never comes.
// withRealWeekday() therefore slides the stored slate dates back one day for the duration of one callback (the
// assignment run) on such weekdays, which is what a real calendar has (Friday or Sunday). Only stored slate dates move;
// locks, tip times and the feed are unchanged, and every other worker runs on the plain sliding calendar.
const OPENING_WEEKDAY = { 0: 4, 1: 6, 2: 4, 3: 6 }
function dateSkew(current) {
  const round = DAYS[current].round
  const secondDay = ROUND_LABEL_DAYS[round]?.length === 2 && ROUND_LABEL_DAYS[round][1] === current
  if (!secondDay) return 0
  const weekday = new Date(`${sim.today}T12:00:00Z`).getUTCDay()
  return weekday === OPENING_WEEKDAY[round] ? 1 : 0
}
async function moveSlateDates(days) {
  await sql('begin')
  try {
    await sql('set local session_replication_role=replica')
    await sql(`update public.slates set slate_date = slate_date + 5000`)
    await sql(`update public.slates set slate_date = slate_date - 5000 + $1::int`, [days])
    await sql(`update public.pools set starts_on = starts_on + $1::int where is_active and starts_on is not null`, [days])
    await sql('commit')
  } catch (error) { await sql('rollback'); throw error }
}
export async function withRealWeekday(current, fn) {
  const skew = dateSkew(current)
  if (!skew) return fn()
  await moveSlateDates(-skew)
  try { return await fn() } finally { await moveSlateDates(skew) }
}

export async function applyCalendar(current, phase) {
  sim.today = sim.today ?? centralDate()
  sim.current = current
  sim.phase = phase
  const now = new Date()
  const byDate = {}
  const tips = new Map()
  const known = new Set(games.map((g) => g.day))
  for (const day of known) {
    const date = addDays(sim.today, day - current)
    byDate[date.replaceAll('-', '')] = []
    for (const game of gamesOfDay(day)) {
      const tip = tipOf(game, day, current, phase, now)
      tips.set(game.espnId, tip)
      byDate[date.replaceAll('-', '')].push(eventOf(game, tip.toISOString()))
    }
  }
  writeEspn(byDate, sim.rankings)
  // Slide the stored schedule. Slates are located through their games' event ids.
  await sql('begin')
  try {
    await sql('set local session_replication_role=replica')
    const stored = await rows(`select g.id, g.espn_event_id, g.slate_id from public.games g where g.espn_event_id = any($1)`, [[...tips.keys()]])
    const slateDay = new Map()
    for (const row of stored) {
      const game = games.find((g) => g.espnId === row.espn_event_id)
      slateDay.set(row.slate_id, game.day)
    }
    // two steps so the unique slate date is never violated mid-update
    await sql(`update public.slates set slate_date = slate_date + 5000 where id = any($1)`, [[...slateDay.keys()]])
    for (const [slateId, day] of slateDay) {
      const dayTips = gamesOfDay(day).map((g) => tips.get(g.espnId))
      const lock = new Date(Math.min(...dayTips.map((t) => t.getTime())))
      await sql(`update public.slates set slate_date=$2::date, locks_at=$3 where id=$1`, [slateId, addDays(sim.today, day - current), lock.toISOString()])
    }
    for (const row of stored) await sql(`update public.games set tip_time=$2 where id=$1`, [row.id, tips.get(row.espn_event_id).toISOString()])
    const first = addDays(sim.today, 0 - current)
    await sql(`update public.pools set starts_on=$1 where is_active`, [first])
    await sql('commit')
  } catch (error) { await sql('rollback'); throw error }
}
