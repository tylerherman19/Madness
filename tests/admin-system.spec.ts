import { test, expect, type Page } from '@playwright/test'
import { adminCookie } from './support/admin'

const DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const rows = async (request: import('@playwright/test').APIRequestContext, path: string) => (await (await request.get(`${DB}${path}`)).json()) as Row[]
const admin = async (page: Page) => page.context().addCookies([await adminCookie()])
const central = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
const DAY = 86_400_000
const BANNED = /correlation|lease|idempotent|workload|partial|outbox/i

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${DB}/__test/reset`)).ok()).toBeTruthy()
})

test.describe('System status page', () => {
  test('with nothing wrong the headline says everything is running, in plain words', async ({ page }) => {
    await admin(page)
    await page.goto('/admin/system')
    await expect(page.getByRole('heading', { name: 'System status', exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Everything is running' })).toBeVisible()
    for (const heading of ['Needs your attention', 'Automatic jobs', 'Today']) await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Automatic jobs' })).toContainText('Move to the next day')
    await expect(page.getByText('Email: switched off')).toBeVisible()
    const text = await page.locator('main').innerText()
    expect(text).not.toMatch(BANNED)
    expect(text).not.toMatch(/recurring:|api\/cron|\{"/)
  })

  test('open incidents get plain cards; marking one resolved needs a note, is audited, and updates the headline', async ({ page, request }) => {
    for (const key of ['turnover-missed:2099-01-02', 'result-review:abc']) {
      expect((await request.post(`${DB}/incidents`, { data: { key, impact: 'raw technical text', occurrences: 3 } })).ok()).toBeTruthy()
    }
    await admin(page)
    await page.goto('/admin/system')
    await expect(page.getByRole('status').filter({ hasText: '2 things need your attention' })).toBeVisible()
    await expect(page.getByRole('article', { name: 'A game result needs a decision' })).toContainText('What to do')
    await expect(page.locator('main')).not.toContainText('raw technical text')
    const card = page.getByRole('article', { name: 'A game result needs a decision' })
    const button = card.getByRole('button', { name: /Mark as resolved/ })
    await expect(button).toBeDisabled()
    await card.getByLabel(/Note for/).fill('Checked the game, result is right')
    await button.click()
    await expect(page.getByRole('status').filter({ hasText: '1 thing needs your attention' })).toBeVisible()
    expect((await rows(request, '/incidents?key=eq.result-review:abc'))[0].status).toBe('resolved')
    expect((await rows(request, '/incidents?key=eq.turnover-missed:2099-01-02'))[0].status).toBe('open')
    const audit = await rows(request, '/audit_log?event_type=eq.incident-resolved')
    expect(audit).toHaveLength(1)
    expect(audit[0].details.note).toBe('Checked the game, result is right')
  })

  test('a job problem that has since recovered is not counted and can be cleared; human-decision problems stay', async ({ page, request }) => {
    const old = new Date(Date.now() - 3 * DAY).toISOString()
    for (const key of ['api/cron/worker/results', 'api/cron/auto-advance', 'turnover-missed:2099-01-02']) {
      await request.post(`${DB}/incidents`, { data: { key, impact: 'x', occurrences: 42, first_at: old, latest_at: old } })
    }
    for (const kind of ['results', 'advance']) await request.post(`${DB}/operation_runs`, { data: { key: `recurring:${kind}`, status: 'pending', last_success_at: new Date().toISOString() } })
    await admin(page)
    await page.goto('/admin/system')
    await expect(page.getByRole('status').filter({ hasText: '1 thing needs your attention' })).toBeVisible()
    const recovered = page.locator('details', { hasText: 'Recovered by itself' })
    await recovered.locator('summary').click()
    await expect(recovered).toContainText('Updating scores was delayed 42 times')
    await expect(recovered).toContainText('It has been running normally since.')
    await recovered.getByRole('button', { name: 'Clear recovered problems' }).click()
    await expect(page.getByText('Cleared 2.')).toBeVisible()
    expect((await rows(request, '/incidents?key=eq.api/cron/worker/results'))[0].status).toBe('resolved')
    expect((await rows(request, '/incidents?key=eq.turnover-missed:2099-01-02'))[0].status).toBe('open')
  })

  test('navigation is short, old links work, and technical views carry a plain explanation', async ({ page }) => {
    await admin(page)
    await page.goto('/admin/system')
    const nav = page.locator('.admin-desktop-links')
    for (const name of ['Status', 'Activity log', 'Email', 'Advanced details']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible()
    await page.goto('/admin/system/overview')
    await expect(page).toHaveURL(/\/admin\/system\/advanced$/)
    await expect(page.getByText('Optional. Technical records')).toBeVisible({ timeout: 20_000 })
    await page.goto('/admin/system/email')
    await expect(page.getByText('Email is switched off.').first()).toBeVisible()
    await page.goto('/admin/system/jobs')
    await expect(page.getByText('The raw record of each automatic job')).toBeVisible()
  })

  test('phone width: no sideways page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await admin(page)
    await page.goto('/admin/system')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

async function playwrightPlayer(request: import('@playwright/test').APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })
  expect(login.ok()).toBeTruthy()
  return request
}

test.describe('Jump to the current day', () => {
  async function stale(request: import('@playwright/test').APIRequestContext) {
    const now = Date.now()
    const past = (hours: number) => new Date(now - hours * 3_600_000).toISOString()
    const missed = '00000000-0000-4000-8000-0000000000a1', open = '00000000-0000-4000-8000-0000000000a2'
    // The active day is two days old and locked; yesterday was missed; tomorrow is open.
    await request.patch(`${DB}/slates?id=eq.${SLATE}`, { data: { slate_date: central(now - 2 * DAY), locks_at: past(50) } })
    await request.patch(`${DB}/games?slate_id=eq.${SLATE}`, { data: { tip_time: past(50) } })
    const tomorrow = central(now + DAY)
    for (const [id, number, date, tip] of [[missed, 2, central(now - DAY), past(26)], [open, 3, tomorrow, new Date(now + 20 * 3_600_000).toISOString()]] as const) {
      expect((await request.post(`${DB}/slates`, { data: { id, slate_number: number, slate_date: date, season_year: 2099, is_active: false, locks_at: tip } })).ok()).toBeTruthy()
      expect((await request.post(`${DB}/games`, { data: { slate_id: id, espn_event_id: `e${number}`, home_team: `H${number}`, away_team: `V${number}`, tip_time: tip, result: 'pending', status_state: 'pre' } })).ok()).toBeTruthy()
    }
    await request.post(`${DB}/incidents`, { data: { key: `turnover-missed:${central(now - DAY)}`, impact: 'x', occurrences: 5 } })
    return { open, tomorrow }
  }

  test('the banner appears, the jump needs a reason and a confirmation, skips missed days without picks or eliminations, and resolves the missed-day problem', async ({ page, request }) => {
    const { open, tomorrow } = await stale(request)
    await admin(page)
    await page.goto('/admin')
    const banner = page.getByRole('alert').filter({ hasText: 'stuck on an old day' })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('nobody is eliminated for not picking')
    const jump = banner.getByRole('button', { name: 'Jump to the current day' })
    await expect(jump).toBeDisabled()
    await banner.getByLabel('Reason (required)').fill('Site was stuck after the test entry was eliminated')
    await jump.click()
    // Two alive entries have no pick on the old locked day: skipping it needs an explicit yes.
    await expect(banner).toContainText('Confirm to skip it anyway')
    expect((await rows(request, `/slates?id=eq.${SLATE}`))[0].is_active).toBe(true)
    await banner.getByLabel('Skip that day anyway').check()
    await jump.click()
    await expect(banner).toHaveCount(0) // the page refreshed onto the new day

    expect((await rows(request, `/slates?id=eq.${open}`))[0].is_active).toBe(true)
    expect((await rows(request, `/slates?id=eq.${SLATE}`))[0].is_active).toBe(false)
    const incident = (await rows(request, '/incidents')).find((i) => i.key.startsWith('turnover-missed:'))
    expect(incident?.status).toBe('resolved')
    const audit = (await rows(request, '/audit_log?event_type=eq.slate-activated'))[0]
    expect(audit.details.jumped).toBe(true)
    expect(audit.details.to_slate_date).toBe(tomorrow)
    expect(audit.details.reason).toMatch(/stuck/)
    expect(audit.details.skipped_dates.length).toBe(2)

    // Nobody was given a pick or eliminated for the days that were skipped, even after auto-assignment runs.
    expect((await page.request.post('/api/cron/auto-assign')).ok()).toBeTruthy()
    expect(await rows(request, '/picks')).toHaveLength(0)
    const players = await rows(request, '/players')
    expect(players.length).toBeGreaterThan(0)
    expect(players.every((p) => p.status === 'alive')).toBe(true)

    // The entry can pick on the new day, and the status page is clean afterwards.
    const player = await playwrightPlayer(request)
    const picked = await player.post('/api/picks', { data: { slate_id: open, team: 'H3' } })
    expect(picked.ok(), await picked.text()).toBeTruthy()
    await page.goto('/admin/system')
    await expect(page.getByRole('status').filter({ hasText: 'Everything is running' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'stuck on an old day' })).toHaveCount(0)
  })

  test('the jump refuses without a reason and when the day is already current', async ({ page, request }) => {
    await admin(page)
    expect((await page.request.post('/api/admin/set-active-week', { data: { jump_to_current: true } })).status()).toBe(400)
    const notStale = await page.request.post('/api/admin/set-active-week', { data: { jump_to_current: true, reason: 'just checking' } })
    expect(notStale.status()).toBe(409)
    expect((await notStale.json()).code).toBe('not-stale')
    await stale(request)
    await page.goto('/admin/system')
    await expect(page.getByRole('status').filter({ hasText: /thing(s)? need(s)? your attention/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Jump to the current day' })).toBeVisible()
  })
})

test.describe('Admin pick dialog', () => {
  test('offers only the day\'s teams, names the day, and shows a refusal inside the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await admin(page)
    await page.route('**/api/picks', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'A is not playing this slate' }) })
      : route.continue())
    await page.goto('/admin/players')
    await page.getByRole('button', { name: 'Submit Pick' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Pick for Thursday, January 1')
    const options = await dialog.getByLabel('Team').locator('option').allTextContents()
    expect(options).toEqual(['Select team…', 'A (vs B)', 'B (vs A)'])
    await dialog.getByLabel('Team').selectOption('A')
    await dialog.getByLabel('Reason for organizer entry or correction').fill('Organizer entry')
    await dialog.getByRole('button', { name: 'Submit Pick' }).click()
    await expect(dialog.getByRole('alert')).toContainText('A is not playing this slate')
    await expect(dialog).toBeVisible()
  })

  test('says so when the day has no games', async ({ page, request }) => {
    await request.delete(`${DB}/games?slate_id=eq.${SLATE}`)
    await page.setViewportSize({ width: 800, height: 900 })
    await admin(page)
    await page.goto('/admin/players')
    await page.getByRole('button', { name: 'Submit Pick' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('no games on this day')
    await expect(dialog.getByLabel('Team')).toHaveCount(0)
  })
})
