import { test, expect, type APIRequestContext } from '@playwright/test'
import { adminCookie } from './support/admin'
import { seedSeason } from './support/seedSeason.mjs'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? '3017'}`
const ACTIVE = '00000000-0000-4000-8000-000000000001'

// Database requests are counted by the fixture (tests/support/database.mjs).
const resetStats = (request: APIRequestContext) => request.post(`${FIXTURE_DB}/__test/stats/reset`)
const total = async (request: APIRequestContext): Promise<number> => (await (await request.get(`${FIXTURE_DB}/__test/stats`)).json()).total

// Rows written behind the app's back are invisible until the shared cache is
// invalidated; a no-op admin result write (pending -> pending) does that.
async function bustCache(request: APIRequestContext) {
  const cookie = await adminCookie()
  const game = (await (await request.get(`${FIXTURE_DB}/games`)).json())[0]
  const bust = await request.post('/api/results', {
    headers: { Cookie: `${cookie.name}=${cookie.value}` },
    data: { game_id: game.id, result: 'pending' },
  })
  expect(bust.ok(), await bust.text()).toBeTruthy()
}

// Requests made back to back after a priming one: how many database calls each cost.
async function callsPerRequest(request: APIRequestContext, path: string, count = 6): Promise<number[]> {
  expect((await request.get(path)).ok()).toBeTruthy()
  const calls: number[] = []
  for (let i = 0; i < count; i++) {
    await resetStats(request)
    expect((await request.get(path)).ok()).toBeTruthy()
    calls.push(await total(request))
  }
  return calls
}

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})

// The budget. A warm signed-out home view reads nothing: the page is built from
// shared cache entries. One request in a run may land on a 10-second refresh of
// those entries, which is why this is "nearly all", not "all". Whatever the
// history holds, the count must not move: it is what a pool of 1,000 entries on
// 70 pick days would otherwise multiply into dozens of reads per view.
for (const days of [5, 70]) {
  test(`warm home view makes no database calls with ${days} days of history`, async ({ request, playwright }) => {
    test.setTimeout(240_000)
    await seedSeason(FIXTURE_DB, 300, days)
    await bustCache(request)

    const signedOut = await callsPerRequest(request, '/')
    console.log(`MEASURED days=${days} signed_out_calls_per_request=${signedOut.join(',')}`)
    expect(signedOut.filter((n) => n === 0).length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...signedOut)).toBeLessThanOrEqual(15)

    // Signed in: the session check (2 reads) and the player's own picks (1).
    const player = await playwright.request.newContext({ baseURL: APP })
    expect((await player.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })).ok()).toBeTruthy()
    const signedIn = await callsPerRequest(player, '/')
    console.log(`MEASURED days=${days} signed_in_calls_per_request=${signedIn.join(',')}`)
    expect(signedIn.filter((n) => n <= 3).length).toBeGreaterThanOrEqual(5)
    const me = await callsPerRequest(player, '/api/me')
    expect(me.filter((n) => n <= 3).length).toBeGreaterThanOrEqual(5)
    await player.dispose()

    // Signed out, /api/me reads nothing from the database at all once warm.
    expect((await callsPerRequest(request, '/api/me')).filter((n) => n === 0).length).toBeGreaterThanOrEqual(5)
  })
}

// Hidden picks stay out of every shared copy until the day locks, and appear at
// the lock instant without any cache being thrown away.
test('other entries picks are never in the page before the lock and are once it passes', async ({ request, playwright }) => {
  test.setTimeout(120_000)
  const SECRET_A = 'Zorblax State', SECRET_B = 'Quillon Tech'
  const patch = (path: string, data: unknown) => request.patch(`${FIXTURE_DB}${path}`, { data, headers: { 'x-fixture-seed': '1' } })
  expect((await patch('/games', { home_team: SECRET_A, away_team: SECRET_B })).ok()).toBeTruthy()
  const extra = ['u1', 'u2', 'u3'].map((u, i) => ({ id: `00000000-0000-4000-8000-0000000001${i}0`, full_name: `Hidden Picker ${i}`, email: `${u}@example.test`, pin_hash: 'x', status: 'alive' }))
  expect((await request.post(`${FIXTURE_DB}/players`, { data: extra })).ok()).toBeTruthy()
  const picks = [
    ...extra.map((p, i) => ({ player_id: p.id, slate_id: ACTIVE, team: i % 2 ? SECRET_A : SECRET_B, seed: null })),
    // The signed-in fixture player's own pick, which only they may see.
    { player_id: '00000000-0000-4000-8000-000000000002', slate_id: ACTIVE, team: SECRET_B, seed: null },
  ]
  expect((await request.post(`${FIXTURE_DB}/picks`, { data: picks, headers: { 'x-fixture-seed': '1' } })).ok()).toBeTruthy()
  await bustCache(request)

  const other = await playwright.request.newContext({ baseURL: APP })
  expect((await other.post('/api/auth/login', { data: { email: 'other@example.test', password: 'FixturePass123!' } })).ok()).toBeTruthy()
  const owner = await playwright.request.newContext({ baseURL: APP })
  expect((await owner.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })).ok()).toBeTruthy()

  const bodies = async (client: APIRequestContext) => [
    await (await client.get('/')).text(),
    await (await client.get('/', { headers: { RSC: '1' } })).text(),
  ]
  // Twice each, so the second reads the shared copy the first one built.
  for (let round = 0; round < 2; round++) {
    for (const client of [request, other]) {
      for (const body of await bodies(client)) {
        expect(body).not.toContain('Zorblax')
        expect(body).not.toContain('Quillon')
        expect(body).toContain('Hidden Picker 0') // the entry is listed; only its team is hidden
      }
    }
    // The owner sees their own pick, and only that one.
    const own = (await bodies(owner)).join('\n')
    expect(own).toContain('Quillon')
    expect(own).not.toContain('Zorblax')
  }

  // Lock in four seconds: stored lock and first tip move together. Nothing is invalidated afterwards.
  const lockAt = new Date(Date.now() + 4000).toISOString()
  expect((await patch(`/slates?id=eq.${ACTIVE}`, { locks_at: lockAt })).ok()).toBeTruthy()
  expect((await patch('/games', { tip_time: lockAt })).ok()).toBeTruthy()
  await bustCache(request)
  expect((await bodies(request)).join('\n')).not.toContain('Zorblax')
  await new Promise((resolve) => setTimeout(resolve, 4500))
  for (const client of [request, other]) {
    const after = (await bodies(client)).join('\n')
    expect(after).toContain('Zorblax')
    expect(after).toContain('Quillon')
  }
  await other.dispose()
  await owner.dispose()
})
