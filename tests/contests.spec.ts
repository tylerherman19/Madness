import { test, expect } from '@playwright/test'
import { SignJWT } from 'jose'
const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const ARCHIVED = '00000000-0000-4000-8000-000000000050'
const secret = new TextEncoder().encode('fixture-only-signing-secret-at-least-32-characters')
async function admin(page: import('@playwright/test').Page) {
  const jwt = await new SignJWT({ is_admin: true, purpose: 'admin' }).setJti(crypto.randomUUID()).setIssuer('madness')
    .setAudience('madness:local').setIssuedAt().setExpirationTime('1h').setProtectedHeader({ alg: 'HS256' }).sign(secret)
  await page.context().addCookies([{ name: 'survivor_admin', value: jwt, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
}
test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
  expect((await request.post(`${FIXTURE_DB}/__test/archived-contest`)).ok()).toBeTruthy()
})

test('an archived contest stays viewable and its shared email does not block login to the active contest', async ({ page }) => {
  await page.goto('/history')
  await page.getByRole('link', { name: /Fixture Regular Season/ }).click()
  await expect(page).toHaveURL(new RegExp(`/history/${ARCHIVED}$`))
  await expect(page.getByRole('rowheader', { name: 'Archived Player' })).toBeVisible()
  await expect(page.getByText('player+test@example.test')).toHaveCount(0)
  // The same email holds one entry per contest; login resolves the active one.
  const login = await page.request.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })
  expect(login.status()).toBe(200)
  expect((await login.json()).full_name).not.toBe('Archived Player')
})

test('deleting an archived contest is guarded, previewed, and a repeat is a no-op', async ({ page }) => {
  await admin(page)
  const call = (data: object) => page.request.post('/api/admin/delete-contest', { data })
  const preview = await (await call({ pool_id: ARCHIVED, preview: true })).json()
  expect(preview.preview).toMatchObject({ players: 1, picks: 1, deletable: true })
  expect((await call({ pool_id: ARCHIVED, confirm_name: 'fixture regular season', reason: 'cleanup' })).status()).toBe(409)
  const active = await (await page.request.get('/api/admin/pool-config')).json()
  expect((await call({ pool_id: active.pool.id, confirm_name: active.pool.name, reason: 'cleanup' })).status()).toBe(409)
  await page.goto('/admin/config')
  await expect(page.getByRole('heading', { name: 'Delete an archived contest' })).toBeVisible()
  await page.getByLabel('Archived contest').selectOption(ARCHIVED)
  await expect(page.getByText('1 entry and 1 pick will be permanently deleted')).toBeVisible()
  await page.getByLabel('Reason').last().fill('Owner request')
  await page.getByLabel(/Type the contest name/).fill('Fixture Regular Season')
  await page.getByRole('button', { name: /Permanently delete/ }).click()
  await expect(page.getByText(/Deleted 1 entries and 1 picks/)).toBeVisible()
  const again = await (await call({ pool_id: ARCHIVED, confirm_name: 'Fixture Regular Season', reason: 'Owner request' })).json()
  expect(again.result).toMatchObject({ deleted: false, already_empty: true })
  await page.goto('/history')
  await expect(page.getByText('No finished contests yet.')).toBeVisible()
})
