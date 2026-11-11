import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as deadline from './deadline.ts'
import * as competition from './competition.ts'
import * as livePolling from './livePolling.ts'
import * as operationPolicy from './operationPolicy.ts'
import * as playerLabels from './playerLabels.ts'

// The two public feeds run for real here; only the database, ESPN and the
// framework are replaced. Every rule under test — reveal, game state, cache
// lifetime, the sandbox parameter — is the route's own code.

function load(path: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected test dependency: ${name}`)
    return dependencies[name]
  }, exports)
  return exports
}

const NextResponse = {
  json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  redirect: (url: URL, init: ResponseInit) =>
    new Response(null, { status: init.status, headers: { ...(init.headers as Record<string, string>), location: String(url) } }),
}
const nextServer = { NextResponse }
const espnModule = load('./espn.ts', { 'server-only': {} })
const teams = load('./teams.ts', { './db': {} })
const feedRules = load('./feedRules.ts', { 'next/server': nextServer })

const LOCK = '2099-03-19T18:00:00.000Z'
const BEFORE = new Date('2099-03-19T17:58:00.000Z') // two minutes before lock
const AFTER = new Date('2099-03-19T21:00:00.000Z')
const slate = { id: 'slate', slate_number: 4, slate_date: '2099-03-19', season_year: 2099, locks_at: LOCK, is_active: true }
const games = [
  { id: 'g1', slate_id: 'slate', espn_event_id: 'e1', home_team: 'HOME', away_team: 'AWAY', home_team_id: '1', away_team_id: '2',
    tip_time: LOCK, time_tbd: false, result: 'pending', home_score: null, away_score: null, round_label: null, region: null, home_seed: null, away_seed: null, tv: null },
  { id: 'g2', slate_id: 'slate', espn_event_id: 'e2', home_team: 'LATE', away_team: 'VISIT', home_team_id: '3', away_team_id: '4',
    tip_time: '2099-03-19T23:00:00.000Z', time_tbd: false, result: 'pending', home_score: null, away_score: null, round_label: null, region: null, home_seed: null, away_seed: null, tv: null },
]
const players = [
  { id: 'p-viewer', full_name: 'Viewer', email: 'viewer@example.test', status: 'alive', elimination_slate: null },
  { id: 'p-other', full_name: 'Other', email: 'other@example.test', status: 'alive', elimination_slate: null },
]
const picks = [
  { player_id: 'p-viewer', slate_id: 'slate', team: 'HOME', auto_assigned: false },
  { player_id: 'p-other', slate_id: 'slate', team: 'AWAY', auto_assigned: false },
]
const status = {
  pre: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '1:00 PM' },
  live: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: '1st 12:00' },
  final: { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final' },
  postponed: { name: 'STATUS_POSTPONED', state: 'post', completed: false, shortDetail: 'Postponed' },
  canceled: { name: 'STATUS_CANCELED', state: 'post', completed: false, shortDetail: 'Canceled' },
}
function espnEvent(id: string, type: object, home: [string, string, string?, boolean?], away: [string, string, string?, boolean?]) {
  const side = (homeAway: string, [abbr, teamId, score, winner]: [string, string, string?, boolean?]) =>
    ({ homeAway, score, winner, team: { id: teamId, abbreviation: abbr } })
  return { id, date: LOCK, competitions: [{ status: { type }, competitors: [side('home', home), side('away', away)] }] }
}
const firstGame = (type: object, homeScore = '0', awayScore = '0', homeWins?: boolean) =>
  espnEvent('e1', type, ['HOME', '1', homeScore, homeWins], ['AWAY', '2', awayScore, homeWins === undefined ? undefined : !homeWins])
const secondGame = espnEvent('e2', status.pre, ['LATE', '3'], ['VISIT', '4'])

function database(log: string[]) {
  return {
    from(table: string) {
      log.push(table)
      const rows: Record<string, unknown[]> = { slates: [slate], games, players, teams: [] }
      const filters: [string, unknown][] = []
      const result = () => ({ data: (rows[table] ?? []).filter((row) => filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value)), error: null })
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        // Contest scoping (pool_id) is a read filter; the fixture rows all belong to one contest.
        match: () => query,
        order: () => query,
        single: async () => ({ ...result(), data: result().data[0] ?? null }),
        maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }),
        then: (resolve: (value: unknown) => void) => resolve(result()),
      }
      return query
    },
  }
}

function harness(route: string, { now, events, testMode = false }: { now: Date; events: unknown[] | null; testMode?: boolean }) {
  const log: string[] = []
  const db = database(log)
  const dependencies = {
    'next/server': nextServer,
    '@/lib/db': { allRows: async (query: PromiseLike<unknown>) => query },
    '@/lib/playerLabels': playerLabels,
    '@/lib/testMode': { getDb: async () => { log.push('getDb'); return db }, isTestMode: async () => testMode, getEffectiveNow: async () => now },
    '@/lib/deadline': deadline,
    '@/lib/email': { isDeliverable: () => true },
    '@/lib/espn': { ...espnModule, fetchDayScoreboard: async () => { log.push('espn'); return { events: events ?? [], failedGroups: [] } } },
    '@/lib/pool': { getPoolConfig: async () => ({ id: 'pool-1', ended_on: null, competition_mode: 'regular-season' }), poolScope: () => 'pool-1', contestFilter: (scope: string | null) => (scope ? { pool_id: scope } : {}), getActivePoolId: async () => 'pool-1' },
    '@/lib/competition': competition,
    '@/lib/seasonData': { loadPicksForSlates: async () => picks },
    '@/lib/alerts': { reportFailure: async (_db: unknown, report: unknown) => { throw new Error(`unexpected failure ${JSON.stringify(report)}`) } },
    '@/lib/teams': teams,
    '@/lib/sharedData': { getCachedTeamConferences: async () => ({}), getTeamBrandDirectory: async () => ({}) },
    '@/lib/teamBrand': { brandsFor: () => ({}) },
    '@/lib/livePolling': livePolling,
    '@/lib/feedRules': feedRules,
    '@/lib/operationPolicy': operationPolicy,
  }
  const { GET } = load(route, dependencies) as { GET: (request: unknown) => Promise<Response> }
  return {
    log,
    get: (query = '', cookie = '') => GET({ nextUrl: new URL(`https://pool.example/api/feed${query}`), headers: new Headers(cookie ? { cookie } : {}) }),
  }
}

type SweatBody = { players: { name: string; team: string | null; status: string }[]; games: { id: string; state: string; homePlayers: string[]; awayPlayers: string[] }[]; allRevealed: boolean }
const sweat = (options: Parameters<typeof harness>[1]) => harness('../app/api/sweat/route.ts', options)
const live = (options: Parameters<typeof harness>[1]) => harness('../app/api/live-scores/route.ts', options)
const sMaxAge = (response: Response) => Number(/s-maxage=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1])

function assertHidden(body: SweatBody) {
  assert.equal(body.allRevealed, false)
  for (const player of body.players) {
    assert.equal(player.team, null, `${player.name}'s pick must stay hidden`)
    assert.equal(player.status, 'pick_in')
  }
  for (const game of body.games) assert.deepEqual([game.homePlayers, game.awayPlayers], [[], []])
  assert.doesNotMatch(JSON.stringify(body.players), /HOME|AWAY/)
}

test('sweat before lock hides every pick, whatever ESPN says about the game', async () => {
  for (const [label, first] of [
    ['normal', firstGame(status.pre)],
    ['postponed', firstGame(status.postponed)],
    ['cancelled', firstGame(status.canceled)],
    ['early start', firstGame(status.live, '4', '2')],
    ['finished early', firstGame(status.final, '70', '60', true)],
  ] as const) {
    const response = await sweat({ now: BEFORE, events: [first, secondGame] }).get()
    const body = await response.json() as SweatBody
    assertHidden(body)
    assert.match(response.headers.get('cache-control')!, /^public/, label)
    assert.ok(sMaxAge(response) <= 120, `${label}: a pre-lock copy may not outlive the lock (got ${sMaxAge(response)})`)
  }
})

test('sweat before lock cannot be cached past the stored lock even when ESPN shows the first game as postponed', async () => {
  const response = await sweat({ now: new Date('2099-03-19T17:59:50.000Z'), events: [firstGame(status.postponed), secondGame] }).get()
  assert.ok(sMaxAge(response) <= 10, `cached ${sMaxAge(response)}s with 10s to lock`)
})

test('anonymous and signed-in visitors get the same shared response', async () => {
  const feed = sweat({ now: BEFORE, events: [firstGame(status.pre), secondGame] })
  const anonymous = await feed.get()
  const signedIn = await feed.get('', 'madness_session=fixture-session-token')
  assert.deepEqual(await signedIn.json(), await anonymous.json())
  assert.equal(signedIn.headers.get('cache-control'), anonymous.headers.get('cache-control'))
  assert.doesNotMatch(anonymous.headers.get('cache-control')!, /private/)
})

test('sweat after lock reveals picks and grades only definitive finals', async () => {
  const final = await (await sweat({ now: AFTER, events: [firstGame(status.final, '70', '60', true), secondGame] }).get()).json() as SweatBody
  assert.equal(final.allRevealed, true)
  assert.deepEqual(final.players.map((p) => [p.name, p.team, p.status]).sort(), [['Other', 'AWAY', 'lost'], ['Viewer', 'HOME', 'won']])

  for (const type of [status.postponed, status.canceled]) {
    const response = await sweat({ now: AFTER, events: [firstGame(type), secondGame] }).get()
    const body = await response.json() as SweatBody
    assert.deepEqual(body.players.map((p) => p.status), ['pre', 'pre'], `${type.name} is never a loss`)
    assert.equal(body.games.find((game) => game.id === 'e1')?.state, 'pre')
    assert.match(response.headers.get('cache-control')!, /^public/)
  }
  // A final ESPN cannot settle (equal scores) is not a loss either.
  const tied = await (await sweat({ now: AFTER, events: [firstGame(status.final, '70', '70'), secondGame] }).get()).json() as SweatBody
  assert.ok(tied.players.every((p) => p.status === 'pre'))
})

test('sweat ignores ESPN events that are not the stored games', async () => {
  const stranger = espnEvent('e9', status.final, ['HOME', '77', '0'], ['ELSE', '78', '50'])
  const body = await (await sweat({ now: AFTER, events: [stranger, secondGame] }).get()).json() as SweatBody
  assert.equal(body.games.some((game) => game.id === 'e9'), false)
  assert.ok(body.players.every((p) => p.status === 'pre'), 'An unrelated event with the same abbreviation never grades a pick')
})

test('?sandbox outside test mode redirects without touching the database, and is honoured in test mode', async () => {
  for (const feed of [sweat, live]) {
    const production = feed({ now: BEFORE, events: [] })
    const response = await production.get('?sandbox=1')
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get('location')!).search, '')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(production.log, [], 'No database or ESPN work for a bypass attempt')

    const tester = await feed({ now: BEFORE, events: [], testMode: true }).get('?sandbox=1')
    assert.equal(tester.status, 200)
    assert.equal(tester.headers.get('cache-control'), 'private, no-store')
  }
})

type LiveBody = { picksVisible: boolean; games: { id: string; state: string; homePicks?: number; awayPicks?: number }[] }

test('live scores show pick counts only after lock and never a postponed game as final', async () => {
  for (const first of [firstGame(status.pre), firstGame(status.postponed), firstGame(status.live, '4', '2')]) {
    const response = await live({ now: BEFORE, events: [first, secondGame] }).get()
    const body = await response.json() as LiveBody
    assert.equal(body.picksVisible, false)
    assert.ok(body.games.every((game) => game.homePicks === undefined && game.awayPicks === undefined))
    assert.ok(sMaxAge(response) <= 120)
  }
  const postponed = await (await live({ now: AFTER, events: [firstGame(status.postponed), secondGame] }).get()).json() as LiveBody
  assert.equal(postponed.picksVisible, true)
  assert.equal(postponed.games.find((game) => game.id === 'e1')?.state, 'pre')
  const final = await (await live({ now: AFTER, events: [firstGame(status.final, '70', '60', true), secondGame] }).get()).json() as LiveBody
  const graded = final.games.find((game) => game.id === 'e1')
  assert.deepEqual([graded?.state, graded?.homePicks, graded?.awayPicks], ['post', 1, 1])
})

test('a postponed game does not hold the feeds at live cache lifetime once everything else is final', async () => {
  const done = espnEvent('e2', status.final, ['LATE', '3', '81', true], ['VISIT', '4', '70', false])
  for (const feed of [sweat, live]) {
    const response = await feed({ now: AFTER, events: [firstGame(status.postponed), done] }).get()
    assert.equal(sMaxAge(response), livePolling.IDLE_CDN_SECONDS, 'nothing is left to play')
    const body = await response.json() as { games: { id: string; state: string; kickoff: string; timeTbd?: boolean; statusText: string }[]; hasLiveGames: boolean }
    // The pages poll with the same rule; they must not see a game about to tip.
    const schedule = body.games.map((game) => ({ state: game.state, kickoff: game.kickoff, timeTbd: game.timeTbd ?? game.statusText.toLowerCase().includes('tbd') }))
    assert.equal(livePolling.nextPollMs(schedule, body.hasLiveGames, AFTER.getTime()), livePolling.IDLE_POLL_MS)
  }
})

// F-29: every reliability/automation flag combination. Public feeds and the
// pick window only read: the fake database has no write methods at all.
const FLAGS = [['false', 'false'], ['false', 'true'], ['true', 'false'], ['true', 'true']] as const
function withFlags<T>(reliable: string, automation: string, run: () => Promise<T>): Promise<T> {
  const saved = [process.env.TOURNAMENT_RELIABILITY_ENABLED, process.env.AUTOMATION_V2_ENABLED]
  process.env.TOURNAMENT_RELIABILITY_ENABLED = reliable
  process.env.AUTOMATION_V2_ENABLED = automation
  return run().finally(() => {
    for (const [name, value] of [['TOURNAMENT_RELIABILITY_ENABLED', saved[0]], ['AUTOMATION_V2_ENABLED', saved[1]]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test('public feeds never write under any flag combination', async () => {
  for (const [reliable, automation] of FLAGS) {
    await withFlags(reliable, automation, async () => {
      for (const feed of [sweat, live]) {
        // The fixture database exposes only reads; any write would throw.
        const response = await feed({ now: AFTER, events: [firstGame(status.final, '70', '60', true), secondGame] }).get()
        assert.equal(response.status, 200, `flags ${reliable}/${automation}`)
      }
    })
  }
})

test('the pick window only reads, even for a winner whose next day is not synced yet', async () => {
  const pickWindow = load('./pickWindow.ts', {
    'server-only': {},
    './competition': competition,
    './deadline': deadline,
    './espn': { ...espnModule, fetchDayScoreboard: async () => ({ events: [firstGame(status.final, '70', '60', true)], failedGroups: [] }) },
    './seasonData': { loadGamesForSlates: async () => games },
    './testMode': { isTestMode: async () => false },
    './teams': teams,
  }) as { loadPickWindow: (db: unknown, player: string, pool: unknown, now: Date) => Promise<{ pickSlate: { id: string } | null }> }
  const reads: string[] = []
  const readOnly = {
    from(table: string) {
      reads.push(table)
      const rows: Record<string, unknown[]> = { slates: [slate], picks: [{ id: 'k', team: 'HOME', slate_id: 'slate', auto_assigned: false, loss_excused: false, updated_at: LOCK }] }
      const query = {
        select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data: rows[table] ?? [], error: null }),
      }
      return query
    },
  }
  for (const [reliable, automation] of FLAGS) {
    await withFlags(reliable, automation, async () => {
      const window = await pickWindow.loadPickWindow(readOnly, 'p-viewer', { competition_mode: 'regular-season', pick_frequency: 'every-game-day', starts_on: null }, AFTER)
      assert.equal(window.pickSlate?.id, 'slate', 'No next day is created from a page view')
    })
  }
  assert.deepEqual([...new Set(reads)].sort(), ['picks', 'slates'])
})
