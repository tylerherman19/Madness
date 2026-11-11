import 'server-only'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Slate, StandingRow } from '@/types'
import { allRows, selectAll } from './db'
import { publicPlayerLabels } from './playerLabels'
import { survivedPeriodsByOutcome } from './survival'
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
import { isPickRevealed, slateDeadline } from './deadline'
import { getDb, getEffectiveNow } from './testMode'
import { CONTEST_TAG } from './cacheTags'
import { clientFor, getTeamBrandDirectory, schemaOf, type Schema } from './sharedData'
import type { TeamBrandDirectory } from './teamBrand'

// The pool's season, for the Today page and the sweat board.
//
// What every visitor sees is built once and shared, in three layers (all
// invalidated by every write to contest data, see revalidateContest):
//
//   * facts per finished day: that day's picks reduced to who picked what and
//     whether it won, plus its first tip. A finished day never changes, so each
//     is cached on its own for an hour, one small entry per day, and read from
//     the database at most once per invalidation.
//   * the board: the season outline (pool, days, every entry), the active day's
//     games and the standings rows, built from the facts plus the active day.
//     Cached for BOARD_SECONDS and keyed by the active day AND by whether that
//     day has locked, so the copy built before the lock is never served after
//     it. The unlocked copy is built without any pick's team: it only knows who
//     has submitted. Teams are read and cached only under the locked key.
//   * the lock lookup: the active day's id and lock instant, cached for the
//     same few seconds. The lock decision itself, now >= lock, is made on every
//     request, which is what selects the key and so flips the page at the
//     lock instant (give or take BOARD_SECONDS if the schedule just changed).
//
// A signed-in visitor adds only their own small reads (lib/myEntry.ts).

const BOARD_SECONDS = 10
const FACTS_SECONDS = 3600

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

// One finished day, as the standings need it. Picks are [player, team, seed, won].
interface SlateFacts {
  tip: string | null // earliest announced tip: the day's lock, when none is stored
  picks: [player: string, team: string, seed: number | null, won: 0 | 1][]
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

async function readSlateFacts(schema: Schema, slateId: string): Promise<SlateFacts> {
  const db = clientFor(schema)
  const [picks, games] = await Promise.all([
    loadPicksForSlates<SeasonPick>(db, [slateId], 'player_id, slate_id, team, seed, loss_excused'),
    loadGamesForSlates<SeasonGame>(db, [slateId], 'slate_id, home_team, away_team, result, tip_time, time_tbd'),
  ])
  const won = new Map<string, boolean>()
  let tip: number | null = null
  for (const game of games) {
    won.set(game.home_team, game.result === 'home_win')
    won.set(game.away_team, game.result === 'away_win')
    const at = new Date(game.tip_time).getTime()
    if (!game.time_tbd && !isNaN(at) && (tip === null || at < tip)) tip = at
  }
  return {
    tip: tip === null ? null : new Date(tip).toISOString(),
    picks: picks.map((p) => [p.player_id, p.team, p.seed ?? null, p.loss_excused || won.get(p.team) === true ? 1 : 0]),
  }
}

// Two requests for the same key in one server instance share one build, so a
// burst at the lock instant (when the locked key is first asked for) costs one
// round of reads rather than one per viewer.
const building = new Map<string, Promise<unknown>>()
function coalesced<A extends unknown[], R>(name: string, load: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => {
    const key = `${name}:${JSON.stringify(args)}`
    const running = building.get(key) as Promise<R> | undefined
    if (running) return running
    const started = load(...args).finally(() => building.delete(key))
    building.set(key, started)
    return started
  }
}

const cachedSlateFacts = coalesced('facts', unstable_cache(
  readSlateFacts,
  ['contest-slate-facts-v1'],
  { tags: [CONTEST_TAG], revalidate: FACTS_SECONDS }
))

// The active day and its lock instant, for choosing the board's key.
interface ActiveLock { slateId: string | null; lock: string | null }
const cachedActiveLock = coalesced('lock', unstable_cache(
  async (schema: Schema): Promise<ActiveLock> => {
    const db = clientFor(schema)
    const { data, error } = await db.from('slates').select('id, locks_at').eq('is_active', true).limit(1)
    if (error) throw error
    const slate = (data ?? [])[0] as { id: string; locks_at: string | null } | undefined
    if (!slate) return { slateId: null, lock: null }
    const { data: games, error: gamesError } = await db.from('games').select('tip_time, time_tbd').eq('slate_id', slate.id)
    if (gamesError) throw gamesError
    return { slateId: slate.id, lock: slateDeadline(slate, (games ?? []) as Game[])?.toISOString() ?? null }
  },
  ['contest-active-lock-v1'],
  { tags: [CONTEST_TAG], revalidate: BOARD_SECONDS }
))

interface ContestBoard {
  outline: SeasonOutline
  slateGames: Game[] // the active day's games
  picksMade: number // alive entries with a pick on the active day
  standings: StandingRow[]
}

// Builds the shared board. `revealed` says the caller found the active day
// locked: only then are that day's teams read, and only if this build, from the
// day's own games, agrees. Anything doubtful falls on the hiding side.
async function buildBoard(schema: Schema, revealed: boolean, nowIso: string | null): Promise<ContestBoard> {
  const db = clientFor(schema)
  const now = nowIso ? new Date(nowIso) : new Date()
  const outline = await readOutline(db)
  const { pool, slates, players } = outline
  const mode = pool.competition_mode
  const slate = slates.find((s) => s.id === outline.activeSlateId) ?? null
  const past = slate ? slates.filter((s) => s.id !== slate.id && String(s.slate_date) < String(slate.slate_date)) : slates

  const [facts, gamesRes] = await Promise.all([
    Promise.all(past.map((s) => cachedSlateFacts(schema, s.id))),
    slate ? db.from('games').select('*').eq('slate_id', slate.id) : Promise.resolve({ data: [] as Game[], error: null }),
  ])
  if (gamesRes.error) throw gamesRes.error
  const slateGames = (gamesRes.data ?? []) as Game[]
  const slateRevealed = !!slate && revealed && isPickRevealed(slate, slateGames, now)

  const realIds = new Set(players.map((p) => p.id))
  let todayPicks: SeasonPick[] = []
  let submitters: string[] = []
  if (slate) {
    if (slateRevealed) {
      todayPicks = (await loadPicksForSlates<SeasonPick>(db, [slate.id], 'player_id, slate_id, team, seed, loss_excused')).filter((p) => realIds.has(p.player_id))
      submitters = todayPicks.map((p) => p.player_id)
    } else {
      // Before the lock only who has picked is read, never what.
      submitters = (await loadPicksForSlates<{ player_id: string }>(db, [slate.id], 'player_id')).map((p) => p.player_id)
    }
  }

  const currentPicks: Record<string, string[]> = {}
  for (const pick of todayPicks) currentPicks[pick.player_id] = [...(currentPicks[pick.player_id] ?? []), pick.team]
  const submitted = new Set(submitters)
  const alive = players.filter((p) => p.status === 'alive')
  const picksMade = alive.filter((p) => submitted.has(p.id)).length

  try {
    const periods = buildPickPeriods(
      mode,
      slates.map((w) => ({ id: w.id, slate_number: w.slate_number, slate_date: String(w.slate_date), locks_at: w.locks_at })),
      outline.rounds
    )
    const gameOutcome = new Map<string, boolean>()
    for (const game of slateGames) {
      gameOutcome.set(game.home_team, game.result === 'home_win')
      gameOutcome.set(game.away_team, game.result === 'away_win')
    }

    // Every pick the standings count, with whether it won, flattened from the
    // per-day facts plus the active day's picks (only once it has locked).
    const seasonPicks: (SeasonPick & { won: boolean })[] = []
    const visibleSlateIds = new Set<string>()
    past.forEach((day, i) => {
      for (const [player_id, team, seed, won] of facts[i].picks) {
        if (realIds.has(player_id)) seasonPicks.push({ player_id, slate_id: day.id, team, seed, loss_excused: false, won: won === 1 })
      }
      const stub = [{ tip_time: facts[i].tip, time_tbd: false }] as unknown as Game[]
      if (facts[i].tip && isPickRevealed(day, stub, now)) visibleSlateIds.add(day.id)
      else if (isPickRevealed(day, [], now)) visibleSlateIds.add(day.id)
    })
    if (slate && slateRevealed) {
      visibleSlateIds.add(slate.id)
      for (const pick of todayPicks) seasonPicks.push({ ...pick, won: pick.loss_excused || gameOutcome.get(pick.team) === true })
    }

    const revealedPicks: Record<string, string> = {}
    if (slateRevealed) {
      for (const [playerId, teams] of Object.entries(currentPicks)) revealedPicks[playerId] = teams.join(', ')
    }

    // Count slates survived per player from this season's picks (including current slate)
    const periodScopes = Object.fromEntries(periods.map((period) => {
      const quota = sharedRoundPickQuota(mode, pool.pick_frequency, period.round)
      return [period.id, { key: quota ? period.round! : period.id, quota: quota ?? 1 }]
    }))
    const weeksSurvivedByPlayer = survivedPeriodsByOutcome(seasonPicks, periodScopes)
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
      pick_locked: submitted.has(p.id),
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
    return { outline, slateGames, picksMade, standings }
  } catch (error) {
    // The outline and counts are still good; only the table is missing.
    console.error('standings unavailable', error)
    return { outline, slateGames, picksMade, standings: [] }
  }
}

const cachedBoard = coalesced('board', unstable_cache(
  async (schema: Schema, _slateId: string | null, revealed: boolean, nowIso: string | null) => buildBoard(schema, revealed, nowIso),
  ['contest-board-v1'],
  { tags: [CONTEST_TAG], revalidate: BOARD_SECONDS }
))

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
  slateGames: Game[] // the active day's games
  players: SeasonPlayer[]
  aliveCount: number
  eliminatedCount: number
  totalPlayers: number
  picksMade: number
  standings: StandingRow[] | null // the table's rows; teams only once the day has locked
  teamBrands: TeamBrandDirectory
}

// Everything the top of Today and the sweat board need. Null when the
// database can't be read, so the pages can say so instead of failing.
export const getContestCore = cache(async (): Promise<ContestCore | null> => {
  try {
    const db = await getDb()
    const schema = schemaOf(db)
    const [lookup, teamBrands, now] = await Promise.all([cachedActiveLock(schema), getTeamBrandDirectory(), getEffectiveNow()])
    // The lock decision, made now: it picks which board is served.
    const revealed = !!lookup.lock && now >= new Date(lookup.lock)
    const board = await cachedBoard(schema, lookup.slateId, revealed, schema === 'sandbox' ? now.toISOString() : null)
    const { pool, slates, players } = board.outline
    const mode = pool.competition_mode
    const slate = slates.find((s) => s.id === board.outline.activeSlateId) ?? null
    const periods = buildPickPeriods(
      mode,
      slates.map((w) => ({ id: w.id, slate_number: w.slate_number, slate_date: String(w.slate_date), locks_at: w.locks_at })),
      board.outline.rounds
    )
    const currentPeriod = slate ? periods.find((p) => p.id === slate.id) ?? null : null
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
      slateGames: board.slateGames,
      players,
      aliveCount: alive.length,
      eliminatedCount: players.length - alive.length,
      totalPlayers: players.length,
      picksMade: board.picksMade,
      standings: board.standings,
      teamBrands,
    }
  } catch (error) {
    console.error('contest data unavailable', error)
    return null
  }
})

// The standings: every entry's days survived, seed total and losing pick,
// sorted. Built with the board, so this is only a lookup.
export async function getContestStandings(core: ContestCore): Promise<StandingRow[] | null> {
  return core.standings
}
