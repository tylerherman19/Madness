import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test'
import { adminCookie } from './support/admin'

// The 2027 Elite Eight rehearsed end to end in Test Mode, through the same
// admin tools an organizer uses on the live site: seed the sandbox weekend,
// submit pairs as players, cross Saturday's lock on the sandbox clock,
// auto-assign the missed entry, then enter Saturday and Sunday results.
// Rule under test: two picks, both due before Saturday's first tip, and both
// must win.

const fixture = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SATURDAY = '7e57e118-0000-4000-8000-000000000327'
const SUNDAY = '7e57e118-0000-4000-8000-000000000328'
const sandbox = { 'Accept-Profile': 'sandbox' }

type Row = Record<string, unknown>
const rows = async (request: APIRequestContext, table: string, query = '') =>
  (await (await request.get(`${fixture}/${table}${query}`, { headers: sandbox })).json()) as Row[]

async function testMode(page: { request: APIRequestContext }, action: string, extra: Row = {}) {
  const response = await page.request.post('/api/admin/test-mode', { data: { action, ...extra } })
  const body = await response.json()
  expect(response.ok(), `${action}: ${JSON.stringify(body)}`).toBeTruthy()
  return body
}

// A separate browser for each entry, carrying only the sandbox cookies.
async function playerBrowser(browser: Browser, admin: BrowserContext, email: string) {
  const sandboxCookies = (await admin.cookies()).filter((cookie) => cookie.name !== 'survivor_admin')
  const context = await browser.newContext()
  await context.addCookies(sandboxCookies)
  const login = await context.request.post('/api/auth/login', { data: { email, password: 'madness-test' } })
  expect(login.ok(), `login ${email}: ${await login.text()}`).toBeTruthy()
  return context
}

const pair = (context: BrowserContext, picks: [string, string][]) =>
  context.request.post('/api/picks/elite-eight', {
    data: { request_id: crypto.randomUUID(), picks: picks.map(([slate_id, team]) => ({ slate_id, team })) },
  })

test('Test Mode Elite Eight weekend: two picks, one deadline, both must win', async ({ browser }) => {
  test.setTimeout(180_000)
  expect((await (await fetch(`${fixture}/__test/reset`, { method: 'POST' })).ok)).toBeTruthy()

  const admin = await browser.newContext()
  await admin.addCookies([await adminCookie()])
  const adminPage = await admin.newPage()
  await testMode(adminPage, 'enable')
  const seeded = await testMode(adminPage, 'seed_elite_eight', { users: 5 })
  expect(seeded).toMatchObject({ entries: 5, games: 4, lock: '2027-03-27T22:09:00Z' })

  const players = await rows(admin.request, 'players', '?order=full_name.asc')
  expect(players.map((p) => p.full_name)).toEqual([1, 2, 3, 4, 5].map((n) => `Elite Tester ${n}`))
  const id = (n: number) => String(players[n - 1].id)
  const picksOf = async (n: number) =>
    (await rows(admin.request, 'picks', `?player_id=eq.${id(n)}`)).map((p) => [p.slate_id, p.team, p.auto_assigned]).sort()
  const statusOf = async (n: number) => (await rows(admin.request, 'players', `?id=eq.${id(n)}`))[0].status

  // --- Player 1 submits through the page: Saturday CONN + Sunday DUKE.
  const p1 = await playerBrowser(browser, admin, 'test.elite1@nflsurvivor.internal')
  const page = await p1.newPage()
  await page.goto('/pick')
  await expect(page.getByRole('heading', { name: 'Elite Eight picks' })).toBeVisible()
  const submit = page.getByRole('button', { name: 'Submit both picks' })
  await page.getByRole('button', { name: /CONN/ }).click()
  await expect(page.getByText('1 of 2 selected')).toBeVisible()
  await expect(submit).toBeDisabled()
  await page.getByRole('button', { name: /DUKE/ }).click()
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByRole('status')).toContainText('Both picks saved')
  expect(await picksOf(1)).toEqual([[SATURDAY, 'CONN', false], [SUNDAY, 'DUKE', false]])

  // --- One pick alone, or the same team twice, saves nothing.
  const p2 = await playerBrowser(browser, admin, 'test.elite2@nflsurvivor.internal')
  expect((await p2.request.post('/api/picks/elite-eight', {
    data: { request_id: crypto.randomUUID(), picks: [{ slate_id: SATURDAY, team: 'ARIZ' }] },
  })).status()).toBe(400)
  const single = await p2.request.post('/api/picks', { data: { slate_id: SATURDAY, team: 'ARIZ', request_id: crypto.randomUUID() } })
  expect(single.status()).toBe(409)
  expect((await single.json()).error).toBe('Submit both Elite Eight picks together.')
  const duplicate = await pair(p2, [[SATURDAY, 'ARIZ'], [SATURDAY, 'ARIZ']])
  expect(duplicate.status()).toBe(409)
  expect((await duplicate.json()).error).toMatch(/two different/)
  expect(await picksOf(2)).toEqual([])

  // --- Both on Saturday is allowed. Player 2: CONN + ARIZ.
  expect((await pair(p2, [[SATURDAY, 'CONN'], [SATURDAY, 'ARIZ']])).ok()).toBeTruthy()
  // Player 3: HOU (Sat) + AUB (Sun). Player 5: CONN (Sat) + PUR (Sun).
  const p3 = await playerBrowser(browser, admin, 'test.elite3@nflsurvivor.internal')
  expect((await pair(p3, [[SATURDAY, 'HOU'], [SUNDAY, 'KU']])).ok()).toBeTruthy()
  // Changing a pair before the lock: Player 3 swaps KU for AUB, keeping HOU.
  const [hou, ku] = (await rows(admin.request, 'picks', `?player_id=eq.${id(3)}&order=team.asc`)) as { id: string; team: string; slate_id: string; updated_at: string }[]
  expect([hou.team, ku.team]).toEqual(['HOU', 'KU'])
  const change = await p3.request.post('/api/picks/elite-eight', { data: { request_id: crypto.randomUUID(), picks: [
    { slate_id: SATURDAY, team: 'HOU', pick_id: hou.id, expected: hou.updated_at },
    { slate_id: SUNDAY, team: 'AUB', pick_id: ku.id, expected: ku.updated_at },
  ] } })
  expect(change.ok(), await change.text()).toBeTruthy()
  expect(await picksOf(3)).toEqual([[SATURDAY, 'HOU', false], [SUNDAY, 'AUB', false]])
  const p5 = await playerBrowser(browser, admin, 'test.elite5@nflsurvivor.internal')
  expect((await pair(p5, [[SATURDAY, 'CONN'], [SUNDAY, 'PUR']])).ok()).toBeTruthy()
  // Player 4 makes no picks.

  // --- Saturday's first tip locks both picks, including Sunday's.
  await testMode(adminPage, 'set_clock', { iso: seeded.lock })
  const late = await playerBrowser(browser, admin, 'test.elite4@nflsurvivor.internal')
  const latePair = await pair(late, [[SUNDAY, 'DUKE'], [SUNDAY, 'PUR']])
  expect(latePair.status()).toBe(409)
  expect((await latePair.json()).error).toMatch(/locked/)
  expect(await picksOf(4)).toEqual([])

  // --- The missed entry gets two auto-assigned picks: the best seeds left.
  const assign = await adminPage.request.post('/api/cron/auto-assign')
  expect(assign.ok(), await assign.text()).toBeTruthy()
  const auto = await picksOf(4)
  expect(auto).toHaveLength(2)
  expect(auto.every((p) => p[2] === true)).toBeTruthy()
  expect(auto.map((p) => p[1]).sort()).toEqual(['CONN', 'DUKE'])

  // --- Saturday results: CONN beats HOU, GONZ beats ARIZ.
  const games = await rows(admin.request, 'games')
  const game = (team: string) => String(games.find((g) => g.home_team === team || g.away_team === team)!.id)
  const final = async (team: string, winner: 'home' | 'away') => {
    await testMode(adminPage, 'set_score', { game_id: game(team), home_score: winner === 'home' ? 80 : 70, away_score: winner === 'away' ? 80 : 70 })
    await testMode(adminPage, 'finalize_game', { game_id: game(team) })
  }
  await final('CONN', 'away')
  await final('ARIZ', 'home')
  expect(await statusOf(2)).toBe('eliminated') // one Saturday loss is enough
  expect(await statusOf(3)).toBe('eliminated') // Saturday loss, Sunday pick never matters
  for (const n of [1, 4, 5]) expect(await statusOf(n)).toBe('alive') // Saturday win waits on Sunday

  // --- Sunday: DUKE beats KU, AUB beats PUR.
  await adminPage.request.post('/api/admin/set-active-week', { data: { slate_id: SUNDAY, reason: 'Elite Eight rehearsal: Sunday', override: true } })
  expect((await rows(admin.request, 'slates', `?id=eq.${SUNDAY}`))[0].is_active).toBe(true)
  await final('DUKE', 'away')
  await final('PUR', 'home')
  expect(await statusOf(5)).toBe('eliminated') // won Saturday, lost Sunday: both must be right
  expect(await statusOf(1)).toBe('alive') // both right
  expect(await statusOf(4)).toBe('alive') // both auto-assigned picks right
  expect(await statusOf(2)).toBe('eliminated')
  expect(await statusOf(3)).toBe('eliminated') // lost Saturday; the Sunday win does not bring it back

  // --- Production was never touched.
  const production = (await (await fetch(`${fixture}/picks`)).json()) as Row[]
  expect(production.filter((p) => [SATURDAY, SUNDAY].includes(String(p.slate_id)))).toEqual([])

  // --- After the rehearsal, ordinary Test Mode works again.
  await testMode(adminPage, 'reset')
  const ordinary = await testMode(adminPage, 'seed', { users: 2 })
  expect(ordinary.created_users).toBe(2)

  await testMode(adminPage, 'disable')
  for (const context of [admin, p1, p2, p3, p5, late]) await context.close()
})

// The pair is assigned after Saturday's first tip. If that run is late and a
// Saturday team has already lost, the entry must still get both picks (and be
// graded out), not stay alive with no picks and block Sunday.
test('Test Mode Elite Eight: a late auto-assignment after a Saturday loss still writes the pair', async ({ browser }) => {
  test.setTimeout(120_000)
  expect((await (await fetch(`${fixture}/__test/reset`, { method: 'POST' })).ok)).toBeTruthy()
  const admin = await browser.newContext()
  await admin.addCookies([await adminCookie()])
  const adminPage = await admin.newPage()
  await testMode(adminPage, 'enable')
  await testMode(adminPage, 'seed_elite_eight', { users: 2 })
  const players = await rows(admin.request, 'players', '?order=full_name.asc')
  const id = (n: number) => String(players[n - 1].id)
  const picksOf = async (n: number) =>
    (await rows(admin.request, 'picks', `?player_id=eq.${id(n)}`)).map((p) => [p.slate_id, p.team, p.auto_assigned]).sort()
  const statusOf = async (n: number) => (await rows(admin.request, 'players', `?id=eq.${id(n)}`))[0].status

  // Player 1 picks HOU + KU. Player 2 misses the deadline.
  const p1 = await playerBrowser(browser, admin, 'test.elite1@nflsurvivor.internal')
  expect((await pair(p1, [[SATURDAY, 'HOU'], [SUNDAY, 'KU']])).ok()).toBeTruthy()

  // The assignment run is late: Saturday evening, CONN has already lost to HOU.
  await testMode(adminPage, 'set_clock', { iso: '2027-03-28T02:30:00Z' })
  const games = await rows(admin.request, 'games')
  const game = (team: string) => String(games.find((g) => g.home_team === team || g.away_team === team)!.id)
  const final = async (team: string, winner: 'home' | 'away') => {
    await testMode(adminPage, 'set_score', { game_id: game(team), home_score: winner === 'home' ? 80 : 70, away_score: winner === 'away' ? 80 : 70 })
    await testMode(adminPage, 'finalize_game', { game_id: game(team) })
  }
  await final('CONN', 'home') // HOU beats CONN

  const assign = await adminPage.request.post('/api/cron/auto-assign')
  expect(assign.ok(), await assign.text()).toBeTruthy()
  // Same choice as an on-time run: results are never consulted.
  expect(await picksOf(2)).toEqual([[SATURDAY, 'CONN', true], [SUNDAY, 'DUKE', true]])

  // Saturday's other final regrades the day: the late pair's CONN loss counts.
  await final('ARIZ', 'home')
  expect(await statusOf(2)).toBe('eliminated')
  expect(await statusOf(1)).toBe('alive')

  // Sunday is not blocked by Saturday's assignment.
  await adminPage.request.post('/api/admin/set-active-week', { data: { slate_id: SUNDAY, reason: 'Elite Eight rehearsal: Sunday', override: true } })
  const sunday = await adminPage.request.post('/api/cron/auto-assign')
  expect(sunday.ok(), await sunday.text()).toBeTruthy()
  await final('DUKE', 'home') // KU beats DUKE
  expect(await statusOf(1)).toBe('alive')
  expect(await statusOf(2)).toBe('eliminated')

  await testMode(adminPage, 'reset')
  await testMode(adminPage, 'disable')
  for (const context of [admin, p1]) await context.close()
})
