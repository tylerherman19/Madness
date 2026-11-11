import 'server-only'
import { cache } from 'react'
import { randomUUID } from 'node:crypto'
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
// What every visitor sees is read once and shared. Next.js does not reuse a
// cached function that is called from inside another one, so the layers are
// separate cache entries that the request path puts together in memory:
//
//   * the outline: pool settings, the season's days, every entry. 30 seconds.
//   * the active day: its games and who has submitted, plus each submitted
//     team once the day has locked. BOARD_SECONDS, keyed by the day AND by
//     whether it has locked, so the copy built before the lock is never served
//     after it. The unlocked copy is read without any pick's team at all.
//   * one small entry per finished day: that day's picks reduced to who
//     picked what and whether it won. A finished day does not change, so each
//     lasts 15 minutes and is read from the database once per invalidation.
//   * the lock lookup: the active day's id and lock instant, BOARD_SECONDS.
//     The decision now >= lock is made on every request; it picks the key
//     above, so the page flips at the lock instant.
//
// Every entry carries CONTEST_TAG, so every write to contest data
// (revalidateContest) discards all of it. The standings table is computed from
// those entries once per instance and reused until one of them changes.
// A signed-in visitor adds only their own small reads (lib/myEntry.ts).

const BOARD_SECONDS = 10
const OUTLINE_SECONDS = 30
const FACTS_SECONDS = 900

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
  v: string // changes whenever the entry is rebuilt; identifies this copy
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
    v: randomUUID(),
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

// Next.js builds a cached function's key from its source text. The pages and
// route handlers are separate bundles, so the same function reads differently
// in each and they would not share entries. A bound function's source text is
// always the same, which makes the key depend only on the key parts below.
function shared<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return fn.bind(null)
}

// Two requests for the same key in one server instance share one build, so a
// burst at the lock instant (when the locked key is first asked for) costs one
// round of reads rather than one per viewer.
const building = new Map<string, Promise<unknown>>()
function coalesceByKey<R>(key: string, load: () => Promise<R>): Promise<R> {
  const running = building.get(key) as Promise<R> | undefined
  if (running) return running
  const started = load().finally(() => building.delete(key))
  building.set(key, started)
  return started
}
function coalesced<A extends unknown[], R>(name: string, load: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => coalesceByKey(`${name}:${JSON.stringify(args)}`, () => load(...args))
}

const cachedOutline = coalesced('outline', unstable_cache(
  shared(async (schema: Schema) => readOutline(clientFor(schema))),
  ['contest-outline-v2'],
  { tags: [CONTEST_TAG], revalidate: OUTLINE_SECONDS }
))

const cachedSlateFacts = coalesced('facts', unstable_cache(
  shared(readSlateFacts),
  ['contest-slate-facts-v1'],
  { tags: [CONTEST_TAG], revalidate: FACTS_SECONDS }
))

// Changes exactly when the finished-day entries could have: after an
// invalidation or an hour. Tells this instance when to forget its copy of them.
const cachedFactsEpoch = unstable_cache(
  shared(async (schema: Schema) => ({ v: randomUUID(), schema })),
  ['contest-facts-epoch-v1'],
  { tags: [CONTEST_TAG], revalidate: FACTS_SECONDS }
)

// The active day and its lock instant, for choosing the active day's key.
interface ActiveLock { slateId: string | null; lock: string | null }
const cachedActiveLock = coalesced('lock', unstable_cache(
  shared(async (schema: Schema): Promise<ActiveLock> => {
    const db = clientFor(schema)
    const { data, error } = await db.from('slates').select('id, locks_at').eq('is_active', true).limit(1)
    if (error) throw error
    const slate = (data ?? [])[0] as { id: string; locks_at: string | null } | undefined
    if (!slate) return { slateId: null, lock: null }
    const { data: games, error: gamesError } = await db.from('games').select('tip_time, time_tbd').eq('slate_id', slate.id)
    if (gamesError) throw gamesError
    return { slateId: slate.id, lock: slateDeadline(slate, (games ?? []) as Game[])?.toISOString() ?? null }
  }),
  ['contest-active-lock-v1'],
  { tags: [CONTEST_TAG], revalidate: BOARD_SECONDS }
))

interface ActiveDay {
  v: string
  slateId: string | null
  games: Game[]
  // True only when this build found the day locked AND the caller said so.
  revealed: boolean
  // Who has a pick on the day. Teams are read only when revealed.
  submitters: string[]
  picks: SeasonPick[]
}

// Builds the active day. `revealed` says the caller found the day locked: only
// then are the day's teams read, and only if this build, from the day's own
// slate and games, agrees. Anything doubtful falls on the hiding side.
async function readActiveDay(schema: Schema, slateId: string | null, revealed: boolean, nowIso: string | null): Promise<ActiveDay> {
  const empty: ActiveDay = { v: randomUUID(), slateId, games: [], revealed: false, submitters: [], picks: [] }
  if (!slateId) return empty
  const db = clientFor(schema)
  const now = nowIso ? new Date(nowIso) : new Date()
  const [slateRes, gamesRes] = await Promise.all([
    db.from('slates').select('id, locks_at').eq('id', slateId).maybeSingle(),
    db.from('games').select('*').eq('slate_id', slateId),
  ])
  if (slateRes.error) throw slateRes.error
  if (gamesRes.error) throw gamesRes.error
  const games = (gamesRes.data ?? []) as Game[]
  const open = !!slateRes.data && revealed && isPickRevealed(slateRes.data as Slate, games, now)
  if (open) {
    const picks = await loadPicksForSlates<SeasonPick>(db, [slateId], 'player_id, slate_id, team, seed, loss_excused')
    return { ...empty, games, revealed: true, submitters: picks.map((p) => p.player_id), picks }
  }
  // Before the lock only who has picked is read, never what.
  const submitters = (await loadPicksForSlates<{ player_id: string }>(db, [slateId], 'player_id')).map((p) => p.player_id)
  return { ...empty, games, submitters }
}

const cachedActiveDay = coalesced('active', unstable_cache(
  shared(readActiveDay),
  ['contest-active-day-v1'],
  { tags: [CONTEST_TAG], revalidate: BOARD_SECONDS }
))

interface ContestBoard {
  standings: StandingRow[]
}

// Per instance: finished-day facts for the current epoch, and the table built
// from a given set of entries. Keyed by the entries' own version tokens, so a
// rebuilt or invalidated entry can never be paired with an old table.
let factsMemo: { key: string; facts: Map<string, SlateFacts> } | null = null
const boardMemo = new Map<string, ContestBoard>()

async function factsFor(schema: Schema, epoch: string, slateIds: string[]): Promise<SlateFacts[]> {
  const key = `${schema}|${epoch}`
  if (factsMemo?.key !== key) factsMemo = { key, facts: new Map() }
  const memo = factsMemo.facts
  const missing = slateIds.filter((id) => !memo.has(id))
  const loaded = await Promise.all(missing.map((id) => cachedSlateFacts(schema, id)))
  missing.forEach((id, i) => memo.set(id, loaded[i]))
  return slateIds.map((id) => memo.get(id)!)
}

function composeBoard(schema: Schema, epoch: string, outline: SeasonOutline, active: ActiveDay, now: Date): Promise<ContestBoard> {
  const key = [schema, epoch, outline.v, active.v].join('|')
  const memoised = boardMemo.get(key)
  if (memoised) return Promise.resolve(memoised)
  return coalesceByKey(`board:${key}`, () => buildBoard(key, schema, epoch, outline, active, now))
}

async function buildBoard(key: string, schema: Schema, epoch: string, outline: SeasonOutline, active: ActiveDay, now: Date): Promise<ContestBoard> {
  const { pool, slates, players } = outline
  const mode = pool.competition_mode
  const slate = slates.find((s) => s.id === outline.activeSlateId) ?? null
  const past = slate ? slates.filter((s) => s.id !== slate.id && String(s.slate_date) < String(slate.slate_date)) : slates
  const facts = await factsFor(schema, epoch, past.map((s) => s.id))

  // Only if the active day entry is for the day the outline calls active.
  const today = slate && active.slateId === slate.id ? active : null
  const slateRevealed = !!today?.revealed
  const realIds = new Set(players.map((p) => p.id))
  const todayPicks = slateRevealed ? today!.picks.filter((p) => realIds.has(p.player_id)) : []
  const submitted = new Set(today?.submitters ?? [])
  const currentPicks: Record<string, string[]> = {}
  for (const pick of todayPicks) currentPicks[pick.player_id] = [...(currentPicks[pick.player_id] ?? []), pick.team]

  let board: ContestBoard
  try {
    const periods = buildPickPeriods(
      mode,
      slates.map((w) => ({ id: w.id, slate_number: w.slate_number, slate_date: String(w.slate_date), locks_at: w.locks_at })),
      outline.rounds
    )
    const gameOutcome = new Map<string, boolean>()
    for (const game of today?.games ?? []) {
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
      const tipped = [{ tip_time: facts[i].tip, time_tbd: false }] as unknown as Game[]
      if (isPickRevealed(day, facts[i].tip ? tipped : [], now)) visibleSlateIds.add(day.id)
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
    board = { standings }
  } catch (error) {
    console.error('standings unavailable', error)
    throw error
  }
  boardMemo.set(key, board)
  while (boardMemo.size > 6) boardMemo.delete(boardMemo.keys().next().value!)
  return board
}

export interface ContestCore {
  // What the standings table is built from; see getContestStandings.
  board: { schema: Schema; epoch: string; outline: SeasonOutline; active: ActiveDay }
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
  teamBrands: TeamBrandDirectory
}

// Everything the top of Today and the sweat board need. Null when the
// database can't be read, so the pages can say so instead of failing.
export const getContestCore = cache(async (): Promise<ContestCore | null> => {
  try {
    const db = await getDb()
    const schema = schemaOf(db)
    const sandbox = schema === 'sandbox'
    const [lookup, outline, epoch, teamBrands, now] = await Promise.all([
      cachedActiveLock(schema),
      cachedOutline(schema),
      cachedFactsEpoch(schema),
      getTeamBrandDirectory(),
      getEffectiveNow(),
    ])
    // The lock decision, made now: it picks which active-day entry is served.
    const revealed = !!lookup.lock && now >= new Date(lookup.lock)
    const active = await cachedActiveDay(schema, lookup.slateId, revealed, sandbox ? now.toISOString() : null)
    const { pool, slates, players } = outline
    const mode = pool.competition_mode
    const slate = slates.find((s) => s.id === outline.activeSlateId) ?? null
    const periods = buildPickPeriods(
      mode,
      slates.map((w) => ({ id: w.id, slate_number: w.slate_number, slate_date: String(w.slate_date), locks_at: w.locks_at })),
      outline.rounds
    )
    const currentPeriod = slate ? periods.find((p) => p.id === slate.id) ?? null : null
    const alive = players.filter((p) => p.status === 'alive')
    const submitted = new Set(slate && active.slateId === slate.id ? active.submitters : [])
    return {
      board: { schema, epoch: epoch.v, outline, active },
      db,
      schema,
      now,
      pool,
      mode,
      slates,
      slate,
      periods,
      currentPeriod,
      slateGames: slate && active.slateId === slate.id ? active.games : [],
      players,
      aliveCount: alive.length,
      eliminatedCount: players.length - alive.length,
      totalPlayers: players.length,
      picksMade: alive.filter((p) => submitted.has(p.id)).length,
      teamBrands,
    }
  } catch (error) {
    console.error('contest data unavailable', error)
    return null
  }
})

// The standings: every entry's days survived, seed total and losing pick,
// sorted. Built once per instance from the shared entries and reused until one
// of them changes; null when the table can't be built, so the page can say so.
export const getContestStandings = cache(async (core: ContestCore): Promise<StandingRow[] | null> => {
  try {
    const { schema, epoch, outline, active } = core.board
    const board = await composeBoard(schema, epoch, outline, active, core.now)
    return board.standings
  } catch (error) {
    console.error('standings unavailable', error)
    return null
  }
})
