import { test, expect, type Page } from '@playwright/test'
import { adminCookie } from './support/admin'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'
const NEXT = '00000000-0000-4000-8000-000000000011'

async function admin(page: Page) {
  await page.context().addCookies([await adminCookie()])
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
async function rows(request: import('@playwright/test').APIRequestContext, path: string) {
  return (await (await request.get(`${FIXTURE_DB}${path}`)).json()) as Row[]
}

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
  const created = await request.post(`${FIXTURE_DB}/slates`, {
    data: { id: NEXT, slate_number: 2, slate_date: '2099-01-02', season_year: 2099, is_active: false, locks_at: '2099-01-02T18:00:00Z' },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
})

test('day-change routes refuse unauthenticated requests', async ({ request }) => {
  expect((await request.post('/api/admin/set-active-week', { data: { slate_id: NEXT, reason: 'x y z' } })).status()).toBe(401)
  expect((await request.get(`/api/admin/slate-preview?action=activate&slate_id=${NEXT}`)).status()).toBe(401)
  expect((await request.post('/api/cron/auto-advance', { data: { reason: 'x y z' } })).status()).toBe(401)
  expect((await rows(request, `/slates?id=eq.${SLATE}`))[0].is_active).toBe(true)
})

test('set active day shows a preview, requires a reason, runs once and is audited', async ({ page, request }) => {
  await admin(page)
  await page.goto('/admin')
  await page.getByLabel('Day to activate').selectOption({ label: '2099-01-02' })
  await page.getByRole('button', { name: 'Review change' }).click()
  const preview = page.getByLabel('What will happen')
  await expect(preview).toContainText('From: 2099-01-01')
  await expect(preview).toContainText('To: 2099-01-02')
  await expect(preview).toContainText('Alive entries with no pick for the current day: 2')
  await expect(preview).toContainText('1 pending')
  await expect(preview).toContainText('not needed yet')
  const confirm = page.getByRole('button', { name: 'Confirm change' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Reason (required)').fill('Schedule moved')
  await expect(confirm).toBeEnabled()
  let calls = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/api/admin/set-active-week') && r.method() === 'POST') calls++
  })
  await confirm.dblclick()
  await expect(page.getByText('2099-01-02 is now active')).toBeVisible()
  expect(calls).toBe(1)
  expect((await rows(request, `/slates?id=eq.${NEXT}`))[0].is_active).toBe(true)
  const audit = await rows(request, '/audit_log?event_type=eq.slate-activated')
  expect(audit).toHaveLength(1)
  expect(audit[0].details.reason).toBe('Schedule moved')
  expect(audit[0].details.override).toBe(false)
})

test('server rejects a missing reason', async ({ page }) => {
  await admin(page)
  const res = await page.request.post('/api/admin/set-active-week', { data: { slate_id: NEXT } })
  expect(res.status()).toBe(400)
})

test('after lock without auto-assignment the change is refused; override with reason is recorded', async ({ page, request }) => {
  await admin(page)
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()

  // Authoritative server refusal, independent of the page.
  const refused = await page.request.post('/api/admin/set-active-week', { data: { slate_id: NEXT, reason: 'Moving on' } })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).error).toMatch(/Run Auto-Assign first/)
  expect((await rows(request, `/slates?id=eq.${SLATE}`))[0].is_active).toBe(true)
  expect(await rows(request, '/audit_log?event_type=eq.slate-activated')).toHaveLength(0)

  await page.goto('/admin')
  await page.getByLabel('Day to activate').selectOption({ label: '2099-01-02' })
  await page.getByRole('button', { name: 'Review change' }).click()
  await expect(page.getByLabel('What will happen')).toContainText('not completed (day is locked)')
  await expect(page.getByRole('alert').filter({ hasText: 'Run Auto-Assign first' })).toBeVisible()
  await page.getByLabel('Reason (required)').fill('Admin decided to skip')
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeDisabled()
  await page.getByLabel(/Change anyway/).check()
  await page.getByRole('button', { name: 'Change anyway' }).click()
  await expect(page.getByText('2099-01-02 is now active')).toBeVisible()

  const audit = await rows(request, '/audit_log?event_type=eq.slate-activated')
  expect(audit).toHaveLength(1)
  expect(audit[0].details.override).toBe(true)
  expect(audit[0].details.reason).toBe('Admin decided to skip')
  expect(audit[0].details.unpicked_at_change).toBe(2)
  expect(audit[0].message).toMatch(/override/)
})

test('advance shows a preview and needs a reason before it can run', async ({ page }) => {
  await admin(page)
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Review advance' }).click()
  const preview = page.getByLabel('What will happen')
  await expect(preview).toContainText('From: 2099-01-01')
  await expect(preview).toContainText('To: 2099-01-02')
  await expect(preview).toContainText('Alive entries with no pick for the current day: 2')
  await expect(page.getByRole('button', { name: 'Confirm advance' })).toBeDisabled()
  await page.getByLabel('Reason (required)').fill('Day is finished')
  await expect(page.getByRole('button', { name: 'Confirm advance' })).toBeEnabled()
  const noReason = await page.request.post('/api/cron/auto-advance', { data: {} })
  expect(noReason.status()).toBe(400)
})

test('operations page shows job health, assignment state and open incidents', async ({ page, request }) => {
  await request.post(`${FIXTURE_DB}/incidents`, { data: { key: 'api/cron/worker/results', impact: 'Results delayed', occurrences: 7 } })
  await admin(page)
  await page.goto('/admin/operations')
  const jobs = page.getByRole('table', { name: 'Scheduled job health' })
  await expect(jobs).toContainText('Schedule sync')
  await expect(jobs).toContainText('Database connection')
  await expect(page.getByRole('table', { name: 'Open incidents' })).toContainText('Results delayed')
  await expect(page.getByRole('table', { name: 'Open incidents' })).toContainText('7')
  await expect(page.getByRole('alert').filter({ hasText: 'session secret is weak' })).toBeVisible()
})
