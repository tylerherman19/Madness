import { test, expect, type APIRequestContext } from '@playwright/test'
import { adminCookie } from './support/admin'
import { clearEspn, espnEvent, setEspn } from './support/espn'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'
const OTHER_PLAYER = '00000000-0000-4000-8000-000000000003'

test.beforeEach(async ({ request }) => {
  clearEspn()
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})
test.afterEach(() => clearEspn())

async function login(client: APIRequestContext, email: string) {
  expect((await client.post('/api/auth/login', { data: { email, password: 'FixturePass123!' } })).ok()).toBeTruthy()
}
const rows = async (request: APIRequestContext, path: string) => (await (await request.get(`${FIXTURE_DB}${path}`)).json()) as Record<string, unknown>[]

test('an entry an admin eliminates before lock does not expose its hidden pick; after the final it does', async ({ page, request, playwright, baseURL }) => {
  await login(request, 'player+test@example.test')
  expect((await request.post('/api/picks', { data: { slate_id: SLATE, team: 'A' } })).ok()).toBeTruthy()
  const other = await playwright.request.newContext({ baseURL })
  await login(other, 'other@example.test')
  expect((await other.post('/api/picks', { data: { slate_id: SLATE, team: 'B' } })).ok()).toBeTruthy()
  await page.context().addCookies([await adminCookie()])
  const eliminate = await page.context().request.patch(`/api/players/${OTHER_PLAYER}`, { data: { status: 'eliminated', elimination_slate: 1, elimination_reason: 'Removed by the organiser', reason: 'Removed by the organiser' } })
  expect(eliminate.ok(), await eliminate.text()).toBeTruthy()

  const anonymous = await (await playwright.chromium.launch()).newPage({ baseURL })
  const signedIn = await (await playwright.chromium.launch()).newPage({ baseURL, storageState: await request.storageState() })
  for (const viewer of [anonymous, signedIn]) {
    await viewer.goto('/')
    await expect(viewer.getByText('Other Player').first()).toBeVisible()
    await expect(viewer.locator('body')).not.toContainText(/Picked\s+B\b/)
  }

  // The day locks and the pick loses: now it is public.
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { result: 'home_win' } })).ok()).toBeTruthy()
  await expect(async () => {
    await anonymous.goto('/')
    await expect(anonymous.locator('body')).toContainText(/Picked\s+B\b.*lost/, { timeout: 2000 })
  }).toPass({ timeout: 30000 })
  await anonymous.context().browser()?.close()
  await signedIn.context().browser()?.close()
  await other.dispose()
})

test('a winner picks tomorrow tonight although tomorrow was never stored; a loser cannot', async ({ request, playwright, baseURL }) => {
  await login(request, 'player+test@example.test')
  expect((await request.post('/api/picks', { data: { slate_id: SLATE, team: 'A' } })).ok()).toBeTruthy()
  const loser = await playwright.request.newContext({ baseURL })
  await login(loser, 'other@example.test')
  expect((await loser.post('/api/picks', { data: { slate_id: SLATE, team: 'B' } })).ok()).toBeTruthy()

  // Today's game is over, A won, and nothing has stored 2099-01-02 yet.
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
  // The results sync has stored A's win (the database refuses an early pick otherwise).
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { result: 'home_win' } })).ok()).toBeTruthy()
  setEspn({
    '20990101': [espnEvent('fixture', '2099-01-01T18:00:00Z', ['A', '1', '70'], ['B', '2', '60'], true)],
    '20990102': [espnEvent('next1', '2099-01-02T23:00:00Z', ['NHOME', '11'], ['NAWAY', '12'])],
  })
  expect(await rows(request, '/slates?slate_date=eq.2099-01-02')).toHaveLength(0)

  const view = await (await playwright.chromium.launch()).newPage({ baseURL, storageState: await request.storageState() })
  await view.goto('/pick')
  await expect(view.getByRole('radio', { name: /NHOME/ })).toBeVisible()
  expect(await rows(request, '/slates?slate_date=eq.2099-01-02'), 'viewing the page stores nothing').toHaveLength(0)
  await view.getByRole('radio', { name: /NHOME/ }).click()
  await view.getByRole('button', { name: 'Submit pick' }).click()
  await expect(view.getByText(/saved|selected|Locked/i).first()).toBeVisible()
  await expect(view.getByText(/saved|submitted|Locked in/i).first()).toBeVisible()

  const stored = await rows(request, '/slates?slate_date=eq.2099-01-02')
  expect(stored).toHaveLength(1)
  expect(await rows(request, `/picks?slate_id=eq.${stored[0].id}`)).toMatchObject([{ team: 'NHOME' }])

  // The loser is refused the next day and nothing is saved for them.
  const refused = await loser.post('/api/picks', { data: { slate_id: 'espn:2099-01-02', team: 'NHOME' } })
  expect(refused.status()).toBe(400)
  expect(await rows(request, `/picks?slate_id=eq.${stored[0].id}&player_id=eq.${OTHER_PLAYER}`)).toHaveLength(0)
  await view.context().browser()?.close()
  await loser.dispose()
})
