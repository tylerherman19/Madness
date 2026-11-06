import 'server-only'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Slate, StandingRow } from '@/types'
import { allRows, selectAll } from './db'
import { publicPlayerLabels } from './playerLabels'
import { survivedPeriodsByPlayer } from './survival'
import { readPoolConfig } from './pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  sharedRoundPickQuota,
  type CompetitionMode,
  type PickPeriod,
  type PickPeriodGame,
  type PoolConfig,
} from './competition'
import { compareBySeedTotal, seedTotalsByPlayer } from './standings'
import { loadAll, loadGamesForSlates, loadPicksForSlates, seasonYearOf } from './seasonData'
import { isPickRevealed } from './deadline'
import { getDb, getEffectiveNow } from './testMode'
import { CONTEST_TAG } from './cacheTags'
import { clientFor, getTeamBrandDirectory, schemaOf, type Schema } from './sharedData'
import type { TeamBrandDirectory } from './teamBrand'

// The pool's season, for the Today page and the sweat board.
//
// The same for every visitor, so most of it is cached on the server and
// shared, in two pieces that load in parallel:
//
//   * the outline — pool settings, the season's game days, every entry and
//     its status. Small; the top of Today is built from it.
//   * the history — every pick and result from days before the active one.
//     The bulk of the season; only the standings need it.
//
// Both are invalidated by every write to contest data (revalidateContest)
// and expire after 60 seconds regardless. What changes minute to minute is
// read live on every request instead: the active day's games, and picks for
// the active day and any later day, which players are still making.

const CACHE_SECONDS = 60

type PlayerStatus = 'alive' | 'eliminated'
export interface SeasonPlayer {
  id: string
  full_name: string // public label: name, plus an id suffix when names collide
  status: PlayerStatus
  elimination_slate: number | null
  elimination_reason: string | null
  paid: boolean
}

interface SeasonOutline {
  pool: PoolConfig
  slates: Slate[] // the season being played, from the pool's start date on
  activeSlateId: string | null
  players: SeasonPlayer[] // real entries only, by name
  rounds: PickPeriodGame[] // tournament-labelled games, for naming pick periods
}

type SeasonPick = { player_id: string; slate_id: string; team: string; seed: number | null; loss_excused: boolean }
type SeasonGame = Pick<Game, 'slate_id' | 'home_team' | 'away_team' | 'result' | 'tip_time' | 'time_tbd'>

// The history is the largest cached item, and the data cache refuses items
// over 2 MB, so it is stored as index-referenced tuples rather than objects.
interface EncodedHistory {
  openFrom: string | null // days on or after this date are not in it
  slateIds: string[]
  playerIds: string[]
  picks: [player: number, slate: number, team: string, seed: number | null, lossExcused: 0 | 1][]
  games: [slate: number, home: string, away: string, result: string, tip: string, tbd: 0 | 1][]
}

// The contest season, scoped exactly as before: slates from the pool's start
// date on, then the season of the active slate (or the newest season).
function seasonSlatesOf(weeks: Slate[], pool: PoolConfig): Slate[] {
  const contestWeeks = weeks.filter((w) => !pool.starts_on || String(w.slate_date) >= pool.starts_on)
  const seasonYear = seasonYearOf(contestWeeks)
  return contestWeeks.filter((w) => w.season_year === seasonYear)
}

const internalAccount = (email: string | null) => !!email?.endsWith('@nflsurvivor.internal')

async function readOutline(db: SupabaseClient): Promise<SeasonOutline> {
  const [pool, weeks, playersRes, rounds] = await Promise.all([
    readPoolConfig(db),
    loadAll<Slate>(db, 'slates', '*'),
    allRows(db.from('players').select('id, full_name, email, status, elimination_slate, elimination_reason, paid').order('full_name')),
    // Only labelled games can name a round; unlabelled ones are ignored by
    // the period builder, so they needn't be read.
    selectAll<PickPeriodGame>((from, to) =>
      db.from('games').select('slate_id, round_label').not('round_label', 'is', null).order('id').range(from, to)
    ),
  ])
  const slates = seasonSlatesOf(weeks, pool)
  const seasonIds = new Set(slates.map((s) => s.id))
  const real = ((playersRes.data ?? []) as (SeasonPlayer & { email: string | null })[]).filter((p) => !internalAccount(p.email))
  const labels = publicPlayerLabels(real)
  return {
    pool,
    slates,
    activeSlateId: slates.find((s) => s.is_active)?.id ?? null,
    players: real.map((p) => ({
      id: p.id,
      full_name: labels.get(p.id) ?? p.full_name,
      status: p.status,
      elimination_slate: p.elimination_slate,
      elimination_reason: p.elimination_reason,
      paid: p.paid,
    })),
    rounds: rounds.filter((g) => seasonIds.has(g.slate_id)),
  }
}

async function readHistory(db: SupabaseClient): Promise<EncodedHistory> {
  const [pool, weeks] = await Promise.all([
    readPoolConfig(db),
    loadAll<Slate>(db, 'slates', 'id, slate_number, slate_date, season_year, is_active, locks_at'),
  ])
  const season = seasonSlatesOf(weeks, pool)
  const active = season.find((s) => s.is_active)
  const openFrom = active ? String(active.slate_date) : null
  const past = season.filter((s) => openFrom === null || String(s.slate_date) < openFrom)
  const ids = past.map((s) => s.id)
  const [picks, games] = await Promise.all([
    loadPicksForSlates<SeasonPick>(db, ids, 'player_id, slate_id, team, seed, loss_excused'),
    loadGamesForSlates<SeasonGame>(db, ids, 'slate_id, home_team, away_team, result, tip_time, time_tbd'),
  ])
  const slateIndex = new Map(ids.map((id, i) => [id, i]))
  const playerIds: string[] = []
  const playerIndex = new Map<string, number>()
  const indexOfPlayer = (id: string) => {
    let i = playerIndex.get(id)
    if (i === undefined) { i = playerIds.push(id) - 1; playerIndex.set(id, i) }
    return i
  }
  return {
    openFrom,
    slateIds: ids,
    playerIds,
    picks: picks.map((p) => [indexOfPlayer(p.player_id), slateIndex.get(p.slate_id)!, p.team, p.seed ?? null, p.loss_excused ? 1 : 0]),
    games: games.map((g) => [slateIndex.get(g.slate_id)!, g.home_team, g.away_team, g.result, g.tip_time, g.time_tbd ? 1 : 0]),
  }
}

function decodeHistory(history: EncodedHistory): { picks: SeasonPick[]; games: SeasonGame[] } {
  return {
    picks: history.picks.map(([player, slate, team, seed, excused]) => ({
      player_id: history.playerIds[player], slate_id: history.slateIds[slate], team, seed, loss_excused: excused === 1,
    })),
    games: history.games.map(([slate, home_team, away_team, result, tip_time, tbd]) => ({
      slate_id: history.slateIds[slate], home_team, away_team, result: result as Game['result'], tip_time, time_tbd: tbd === 1,
    })),
  }
}

const cachedOutline = unstable_cache(
  async (schema: Schema) => readOutline(clientFor(schema)),
  ['contest-outline-v1'],
  { tags: [CONTEST_TAG], revalidate: CACHE_SECONDS }
)
const cachedHistory = unstable_cache(
  async (schema: Schema) => readHistory(clientFor(schema)),
  ['contest-history-v1'],
  { tags: [CONTEST_TAG], revalidate: CACHE_SECONDS }
)

// One history read per request, started as early as the page likes.
const historyFor = cache((schema: Schema) => cachedHistory(schema))

// Start reading the standings' data now, alongside everything else, so that
// on a cached visit the standings are ready by the time the page is sent and
// their placeholder never appears.
export function preloadContestStandings(): void {
  getDb().then((db) => historyFor(schemaOf(db))).catch(() => {})
}

export interface ContestCore {
  db: SupabaseClient
  schema: Schema
  now: Date
  pool: PoolConfig
  mode: CompetitionMode
  slates: Slate[]
  slate: Slate | null
  periods: PickPeriod[]
  currentPeriod: PickPeriod | null
  slateGames: Game[] // the active day's games, read live
  slateIsToday: boolean
  players: SeasonPlayer[]
  aliveCount: number
  eliminatedCount: number
  totalPlayers: number
  // Live picks for the active day and later: the ones still changing.
  openFrom: string | null
  openPicks: SeasonPick[]
  currentPicks: Record<string, string[]> // active day only, real entries only
  picksMade: number
  teamBrands: TeamBrandDirectory
}

// Everything the top of Today and the sweat board need. Null when the
// database can't be read, so the pages can say so instead of failing.
export const getContestCore = cache(async (): Promise<ContestCore | null> => {
  try {
    const db = await getDb()
    const schema = schemaOf(db)
    const [outline, teamBrands, now] = await Promise.all([cachedOutline(schema), getTeamBrandDirectory(), getEffectiveNow()])
    const { pool, slates, players } = outline
    const mode = pool.competition_mode
    const slate = slates.find((s) => s.id === outline.activeSlateId) ?? null
    const openFrom = slate ? String(slate.slate_date) : null
    const openIds = openFrom ? slates.filter((s) => String(s.slate_date) >= openFrom).map((s) => s.id) : []

    const [openPicks, gamesRes] = await Promise.all([
      loadPicksForSlates<SeasonPick>(db, openIds, 'player_id, slate_id, team, seed, loss_excused'),
      slate ? db.from('games').select('*').eq('slate_id', slate.id) : Promise.resolve({ data: [] as Game[], error: null }),
    ])
    if (gamesRes.error) throw gamesRes.error
    const slateGames = (gamesRes.data ?? []) as Game[]

    const realIds = new Set(players.map((p) => p.id))
    const currentPicks: Record<string, string[]> = {}
    for (const pick of openPicks) {
      if (pick.slate_id !== slate?.id || !realIds.has(pick.player_id)) continue
      currentPicks[pick.player_id] = [...(currentPicks[pick.player_id] ?? []), pick.team]
    }

    // Pick periods: the season's playing days, labelled for the active
    // competition. Regular season reads "Saturday, January 24"; the
    // tournament reads "First Round · Thursday".
    const periods = buildPickPeriods(
      mode,
      slates.map((w) => ({ id: w.id, slate_number: w.slate_number, slate_date: String(w.slate_date), locks_at: w.locks_at })),
      outline.rounds
    )
    const currentPeriod = slate ? periods.find((p) => p.id === slate.id) ?? null : null

    // "TODAY" only when the active slate really is today in Central — the
    // pool's own timezone. Every other day gets its own name.
    const centralToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const alive = players.filter((p) => p.status === 'alive')

    return {
      db,
      schema,
      now,
      pool,
      mode,
      slates,
      slate,
      periods,
      currentPeriod,
      slateGames,
      slateIsToday: slate ? String(slate.slate_date).slice(0, 10) === centralToday : false,
      players,
      aliveCount: alive.length,
      eliminatedCount: players.length - alive.length,
      totalPlayers: players.length,
      openFrom,
      openPicks,
      currentPicks,
      picksMade: alive.filter((p) => (currentPicks[p.id]?.length ?? 0) > 0).length,
      teamBrands,
    }
  } catch (error) {
    console.error('contest data unavailable', error)
    return null
  }
})

// The standings: every entry's days survived, seed total and losing pick,
// sorted. Needs the whole season's picks, so it comes from the history.
export const getContestStandings = cache(async (core: ContestCore): Promise<StandingRow[] | null> => {
  try {
    const history = await historyFor(core.schema)
    const { pool, mode, slates, slate, players, now } = core
    const { picks: pastPicks, games: pastGames } = decodeHistory(history)

    // What is live wins. If the two cached pieces were built either side of a
    // day change, read any day neither of them covers.
    const openIds = new Set(core.openFrom ? slates.filter((s) => String(s.slate_date) >= core.openFrom!).map((s) => s.id) : [])
    const covered = new Set([...history.slateIds, ...openIds])
    const gapIds = slates.filter((s) => !covered.has(s.id) && slate?.id !== s.id).map((s) => s.id)
    const [gapPicks, gapGames] = gapIds.length
      ? await Promise.all([
          loadPicksForSlates<SeasonPick>(core.db, gapIds, 'player_id, slate_id, team, seed, loss_excused'),
          loadGamesForSlates<SeasonGame>(core.db, gapIds, 'slate_id, home_team, away_team, result, tip_time, time_tbd'),
        ])
      : [[], []]

    const seasonWeekIds = new Set(slates.map((s) => s.id))
    const realPlayerIds = new Set(players.map((p) => p.id))
    const seasonPicks = [...pastPicks.filter((p) => !openIds.has(p.slate_id)), ...gapPicks, ...core.openPicks]
      .filter((p) => seasonWeekIds.has(p.slate_id) && realPlayerIds.has(p.player_id))
    const allGames: SeasonGame[] = [...pastGames.filter((g) => g.slate_id !== slate?.id), ...gapGames, ...core.slateGames]
    const gamesBySlate = new Map<string, SeasonGame[]>()
    for (const game of allGames) gamesBySlate.set(game.slate_id, [...(gamesBySlate.get(game.slate_id) ?? []), game])

    // The slate reveals as a unit at its first tip, so this is one decision
    // for every pick rather than a per-team lookup.
    const currentPicks = core.currentPicks
    const revealedPicks: Record<string, string> = {}
    if (slate && isPickRevealed(slate, (gamesBySlate.get(slate.id) ?? []) as Game[], now)) {
      for (const [playerId, teams] of Object.entries(currentPicks)) revealedPicks[playerId] = teams.join(', ')
    }

    // Count slates survived per player from this season's picks (including current slate)
    const periodScopes = Object.fromEntries(core.periods.map((period) => {
      const quota = sharedRoundPickQuota(mode, pool.pick_frequency, period.round)
      return [period.id, { key: quota ? period.round! : period.id, quota: quota ?? 1 }]
    }))
    const weeksSurvivedByPlayer = survivedPeriodsByPlayer(seasonPicks, allGames, periodScopes)
    const visibleSlateIds = new Set(slates.filter((day) => isPickRevealed(day, (gamesBySlate.get(day.id) ?? []) as Game[], now)).map((day) => day.id))
    const seedTotalByPlayer = seedTotalsByPlayer(seasonPicks.filter((p) => visibleSlateIds.has(p.slate_id)))

    // The team that knocked each eliminated entry out: their pick on the day
    // they were eliminated. That day is locked and graded, so it is public.
    const slateNumberById = new Map<string, number>(slates.map((w) => [w.id, w.slate_number]))
    const eliminationSlateByPlayer = new Map<string, number>(
      players
        .filter((p) => p.status === 'eliminated' && p.elimination_slate != null)
        .map((p) => [p.id, p.elimination_slate!])
    )
    const losingPicksByPlayer: Record<string, string[]> = {}
    for (const pick of seasonPicks) {
      const out = eliminationSlateByPlayer.get(pick.player_id)
      if (out != null && slateNumberById.get(pick.slate_id) === out) {
        losingPicksByPlayer[pick.player_id] = [...(losingPicksByPlayer[pick.player_id] ?? []), pick.team]
      }
    }

    const standings: StandingRow[] = players.map((p) => ({
      player_id: p.id,
      full_name: p.full_name,
      status: p.status,
      slates_survived: weeksSurvivedByPlayer[p.id] || 0,
      seed_total: seedTotalByPlayer[p.id] || 0,
      current_pick: revealedPicks[p.id] ? currentPicks[p.id]?.[0] || null : null,
      current_picks: revealedPicks[p.id] ? currentPicks[p.id] || [] : [],
      pick_locked: (currentPicks[p.id]?.length ?? 0) > 0,
      pick_revealed: !!revealedPicks[p.id],
      elimination_reason: p.elimination_reason,
      elimination_slate: p.elimination_slate,
      losing_picks: losingPicksByPlayer[p.id] ?? [],
    }))

    standings.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
      return capabilitiesFor(mode).showSeedTotal
        ? compareBySeedTotal(a, b)
        : b.slates_survived - a.slates_survived || a.full_name.localeCompare(b.full_name)
    })
    return standings
  } catch (error) {
    console.error('standings unavailable', error)
    return null
  }
})
