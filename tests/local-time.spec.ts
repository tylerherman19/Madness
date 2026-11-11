import { test, expect } from '@playwright/test'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})

// The fixture slate locks 2099-01-01 18:00 UTC: 12:00 PM CST, 1:00 PM EST.
const lockLabel = (page: import('@playwright/test').Page) => page.getByText(/Locks.*\d:\d\d [AP]M/).first()

test('the home lock time follows the browser zone and falls back to Central without JavaScript', async ({ browser }) => {
  const cases: [string, RegExp][] = [
    ['America/New_York', /1:00 PM EST/],
    ['Pacific/Honolulu', /8:00 AM HST/],
    ['America/Phoenix', /11:00 AM MST/],
    ['America/Chicago', /12:00 PM CST/],
  ]
  for (const [timezoneId, expected] of cases) {
    const context = await browser.newContext({ timezoneId })
    const page = await context.newPage()
    await page.goto('/')
    await expect(lockLabel(page)).toHaveText(expected)
    await context.close()
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, timezoneId: 'America/New_York' })
  const page = await noScript.newPage()
  await page.goto('/')
  await expect(lockLabel(page)).toHaveText(/12:00 PM CST/)
  await noScript.close()
})

test('a browser reporting a time zone the page cannot use still gets Central, with no hydration error', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('console', (message) => { if (/hydrat/i.test(message.text())) problems.push(message.text()) })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: 'Not/AZone' }
    }
  })
  await page.goto('/')
  await expect(lockLabel(page)).toHaveText(/12:00 PM CST/)
  expect(problems).toEqual([])
  await context.close()
})

test('the pick page lock time uses the viewer zone and no longer hard-codes CT', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' })
  const login = await context.request.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })
  expect(login.ok()).toBeTruthy()
  const page = await context.newPage()
  await page.goto('/pick')
  await expect(page.getByText(/Locks at 1:00 PM EST/).first()).toBeVisible()
  await expect(page.getByText(/\bCT\b/)).toHaveCount(0)
  await context.close()
})
