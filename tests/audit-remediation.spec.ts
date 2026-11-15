// Regressions for the 2026-11-14 audit fixes (SEC-05, INT-03, REL-03, USE-01,
// USE-03, USE-05, SEC-08). Runs against the local fixture database only.
import { test, expect, type APIRequestContext } from '@playwright/test'
import { createHash } from 'node:crypto'
import { adminCookie } from './support/admin'
import { clearEspn, espnEvent, setEspn } from './support/espn'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'

test.beforeEach(async ({ request }) => {
  clearEspn()
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})
test.afterEach(() => clearEspn())

const rows = async (request: APIRequestContext, path: string) => (await (await request.get(`${FIXTURE_DB}${path}`)).json()) as Record<string, unknown>[]
async function login(client: APIRequestContext, email: string) {
  expect((await client.post('/api/auth/login', { data: { email, password: 'FixturePass123!' } })).ok()).toBeTruthy()
}
// Incidents, audit rows and queued organizer alerts.
async function sideEffects(request: APIRequestContext) {
  const [incidents, audit, outbox] = await Promise.all([rows(request, '/incidents'), rows(request, '/audit_log'), rows(request, '/notification_outbox')])
  return { incidents: incidents.length, audit: audit.length, outbox: outbox.length }
}
const MALFORMED: { body: string; type: string }[] = [
  { body: '{not json', type: 'application/json' },
  { body: 'null', type: 'application/json' },
  { body: '[]', type: 'application/json' },
  { body: '"text"', type: 'application/json' },
  { body: '{"slate_id":5,"team":["A"]}', type: 'application/json' },
  { body: `{"slate_id":"${SLATE}","team":"A","request_id":7}`, type: 'application/json' },
  { body: 'plain', type: 'text/plain' },
]

test('malformed pick bodies return 400 with no incident, audit row or alert — signed out and signed in', async ({ request, playwright, baseURL }) => {
  const before = await sideEffects(request)
  const anonymous = await playwright.request.newContext({ baseURL })
  const player = await playwright.request.newContext({ baseURL })
  await login(player, 'player+test@example.test')
  const afterLogin = await sideEffects(request)
  for (const client of [anonymous, player]) {
    for (const { body, type } of MALFORMED) {
      const response = await client.post('/api/picks', { headers: { 'Content-Type': type }, data: body })
      // Signed out, a well-formed object is refused at sign-in (401) before its
      // fields are checked; anything unparseable is 400. Never 5xx.
      if (client === anonymous) expect([400, 401], body).toContain(response.status())
      else expect(response.status(), body).toBe(400)
    }
  }
  const malformedAdminLogin = await anonymous.post('/api/auth/admin', { headers: { 'Content-Type': 'application/json' }, data: '{not json' })
  expect(malformedAdminLogin.status()).toBe(400)
  expect(await sideEffects(request)).toEqual(afterLogin)
  expect(afterLogin.incidents).toBe(before.incidents)
  expect(await rows(request, '/picks')).toHaveLength(0)
  await anonymous.dispose(); await player.dispose()
})

test('reserved test-account email domain cannot sign up publicly, in any letter case', async ({ request }) => {
  for (const email of ['sneaky@nflsurvivor.internal', 'Sneaky@NFLSurvivor.Internal', 'x@sub.nflsurvivor.internal', ' y@nflsurvivor.internal. ']) {
    const response = await request.post('/api/signup', { data: { full_name: 'Hidden Entry', email, phone: '6085551234', venmo: '@hidden', password: 'FixturePass123!' } })
    expect(response.status(), email).toBe(400)
    expect((await response.json()).error).toMatch(/cannot be used/)
  }
  expect(await rows(request, '/players?full_name=eq.Hidden Entry')).toHaveLength(0)
  // A normal address still works.
  const ok = await request.post('/api/signup', { data: { full_name: 'Real Entry', email: 'real.entry@example.test', phone: '6085551234', venmo: '@real', password: 'FixturePass123!' } })
  expect(ok.ok()).toBeTruthy()
})

test('early next-day pick while the stored result is pending: clear 409, no incident, saved once the result is stored', async ({ request, playwright, baseURL }) => {
  await login(request, 'player+test@example.test')
  expect((await request.post('/api/picks', { data: { slate_id: SLATE, team: 'A' } })).ok()).toBeTruthy()
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
  // ESPN shows A won; the database result is still pending.
  setEspn({
    '20990101': [espnEvent('fixture', '2099-01-01T18:00:00Z', ['A', '1', '70'], ['B', '2', '60'], true)],
    '20990102': [espnEvent('next1', '2099-01-02T23:00:00Z', ['NHOME', '11'], ['NAWAY', '12'])],
  })
  const view = await (await playwright.chromium.launch()).newPage({ baseURL, storageState: await request.storageState() })
  await view.goto('/pick')
  await expect(view.getByText(/being confirmed/)).toBeVisible()
  const before = await sideEffects(request)
  const pending = await request.post('/api/picks', { data: { slate_id: 'espn:2099-01-02', team: 'NHOME' } })
  expect(pending.status()).toBe(409)
  expect((await pending.json()).error).toMatch(/still being confirmed/)
  const after = await sideEffects(request)
  expect(after.incidents).toBe(before.incidents)
  expect(after.outbox).toBe(before.outbox)
  // The browser keeps the selection and says why.
  await view.getByRole('radio', { name: /NHOME/ }).click()
  await view.getByRole('button', { name: 'Submit pick' }).click()
  await expect(view.locator('p[role=alert]')).toContainText(/still being confirmed/)
  // Results job stores the win: the same pick now saves.
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { result: 'home_win' } })).ok()).toBeTruthy()
  await view.getByRole('button', { name: 'Submit pick' }).click()
  await expect(view.getByRole('status').filter({ hasText: /Saved: NHOME/ })).toBeVisible()
  await view.context().browser()?.close()
})

test('a selection still unsubmitted when the lock passes is reported as not saved, after the refresh too', async ({ page, request }) => {
  await login(page.request, 'player+test@example.test')
  // Lock in a few seconds.
  const soon = new Date(Date.now() + 12000).toISOString()
  expect((await request.patch(`${FIXTURE_DB}/slates?id=eq.${SLATE}`, { data: { locks_at: soon } })).ok()).toBeTruthy()
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { tip_time: soon } })).ok()).toBeTruthy()
  await page.goto('/pick')
  await page.getByRole('radio', { name: /\bA\b/ }).first().click()
  await expect(page.locator('p[role=alert]')).toContainText(/locked at .* before you submitted\. .* was not saved/, { timeout: 25000 })
  await page.reload()
  await expect(page.locator('p[role=alert]')).toContainText(/was not saved/)
  expect(await rows(request, '/picks')).toHaveLength(0)
})

test('a refused change keeps its message across the refresh and names the saved pick', async ({ page, request, playwright, baseURL }) => {
  await login(page.request, 'player+test@example.test')
  await page.goto('/pick')
  await page.getByRole('radio', { name: /\bA\b/ }).first().click()
  await page.getByRole('button', { name: 'Submit pick' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Saved: A/ })).toBeVisible()
  // The server locks the day while this page's clock still shows it open.
  await page.getByRole('button', { name: 'Change pick' }).first().click()
  await page.getByRole('radio', { name: /\bB\b/ }).first().click()
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
  await page.getByRole('button', { name: 'Submit pick' }).click()
  // The refusal survives the refresh/remount and points at the saved pick.
  await expect(page.locator('p[role=alert]')).toContainText(/B was not saved — your saved pick is shown below/)
  await page.waitForTimeout(2000)
  await expect(page.locator('p[role=alert]')).toContainText(/was not saved/)
  expect((await rows(request, '/picks'))[0].team).toBe('A')
  void playwright; void baseURL
})

test('an expired session at submit says the pick was not saved', async ({ page, context }) => {
  await login(page.request, 'player+test@example.test')
  await page.goto('/pick')
  await page.getByRole('radio', { name: /\bA\b/ }).first().click()
  await context.clearCookies()
  await page.getByRole('button', { name: 'Submit pick' }).click()
  await expect(page.locator('p[role=alert]')).toContainText(/session expired.*not saved/i)
})

test('admin deletions need a reason and are audited', async ({ page, request }) => {
  await page.context().addCookies([await adminCookie()])
  const player = (await rows(request, '/players?email=eq.other@example.test'))[0]
  expect((await page.request.delete(`/api/players/${player.id}`)).status()).toBe(400)
  expect((await page.request.delete(`/api/players/${player.id}?reason=Duplicate%20entry`)).ok()).toBeTruthy()
  const audit = await rows(request, '/audit_log?event_type=eq.player-deleted')
  expect(audit[0].details).toMatchObject({ reason: 'Duplicate entry' })
  const game = (await rows(request, '/games'))[0]
  expect((await page.request.delete(`/api/schedule?id=${game.id}`)).status()).toBe(400)
  expect((await page.request.delete(`/api/schedule?id=${game.id}&reason=Cancelled%20by%20conference`)).ok()).toBeTruthy()
  expect((await rows(request, '/audit_log?event_type=eq.game-deleted'))[0].details).toMatchObject({ reason: 'Cancelled by conference' })
})

test('a phone whose clock runs ten minutes fast is not locked out early (server time drives the lock)', async ({ page, request }) => {
  await login(page.request, 'player+test@example.test')
  const lock = new Date(Date.now() + 5 * 60_000).toISOString()
  expect((await request.patch(`${FIXTURE_DB}/slates?id=eq.${SLATE}`, { data: { locks_at: lock } })).ok()).toBeTruthy()
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { tip_time: lock } })).ok()).toBeTruthy()
  await page.clock.install({ time: new Date(Date.now() + 10 * 60_000) })
  await page.goto('/pick')
  await page.getByRole('radio', { name: /\bA\b/ }).first().click()
  await page.clock.runFor(3000)
  await expect(page.getByRole('heading', { name: 'Choose a team' })).toBeVisible()
  await expect(page.locator('p[role=alert]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Submit pick' }).first()).toBeEnabled()
})

test('SEC-06: refused attempts never count toward the account cap; the cap stops rotating addresses', async ({ playwright, baseURL, request }) => {
  const client = await playwright.request.newContext({ baseURL })
  const email = 'player+test@example.test'
  const key = `login-account:${createHash('sha256').update(email).digest('hex')}`
  const attempt = (ip: string, password = 'WrongPassword123') => client.post('/api/auth/login', { headers: { 'x-real-ip': ip }, data: { email, password } })
  // One address: 40 bad attempts, only the first 10 pass its own limit.
  const statuses: number[] = []
  for (let i = 0; i < 40; i++) statuses.push((await attempt('198.51.100.1')).status())
  expect(statuses.filter(s => s === 401)).toHaveLength(10)
  expect(statuses.filter(s => s === 429)).toHaveLength(30)
  expect((await rows(request, `/rate_limits?key=eq.${key}`))[0].count).toBe(10)
  // The owner can still sign in from somewhere else.
  expect((await attempt('198.51.100.2', 'FixturePass123!')).status()).toBe(200)
  // Rotating addresses reaches the cross-network cap (100 an hour), then stops.
  let used = 11, n = 3
  while (used < 100) {
    const ip = `198.51.100.${n++}`
    for (let i = 0; i < 10 && used < 100; i++, used++) expect((await attempt(ip)).status()).toBe(401)
  }
  expect((await attempt(`198.51.100.${n}`)).status()).toBe(429)
  await client.dispose()
})
