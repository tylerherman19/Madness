import { test, expect } from '@playwright/test'
import { SignJWT } from 'jose'
const FIXTURE_DB=`http://127.0.0.1:${process.env.E2E_DB_PORT??'54329'}`
const secret = new TextEncoder().encode(
  'fixture-only-signing-secret-at-least-32-characters',
)
async function admin(page: import('@playwright/test').Page) {
  const jwt = await new SignJWT({ is_admin: true, purpose: 'admin' })
    .setJti(crypto.randomUUID())
    .setIssuer('madness')
    .setAudience('madness:local')
    .setIssuedAt()
    .setExpirationTime('1h')
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret)
  await page
    .context()
    .addCookies([
      {
        name: 'survivor_admin',
        value: jwt,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
}
test.beforeEach(async ({ request }) => {
  await request.post(`${FIXTURE_DB}/__test/reset`)
})
test('both workspaces and mutation routes enforce the same admin authorization', async ({
  page,
  request,
}) => {
  for (const path of [
    '/admin',
    '/admin/system',
    '/admin/system/email',
    '/admin/system/jobs',
    '/admin/system/integrity',
    '/admin/picks',
  ]) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/admin\/login/)
  }
  for (const path of [
    '/api/admin/system',
    '/api/admin/broadcast',
    '/api/admin/operations',
  ])
    expect(
      (
        await request.post(path, {
          data: { action: 'mode', mode: 'live', reason: 'Unauthorized' },
        })
      ).status(),
    ).toBe(401)
})
test('workspace switching, truthful disabled mode, campaign receipt and message drill-down work', async ({
  page,
}) => {
  await admin(page)
  await page.goto('/admin/system')
  await expect(
    page.getByRole('heading', { name: 'System status', exact: true }),
  ).toBeVisible()
  await page
    .locator('.workspace-switch')
    .getByRole('link', { name: 'Game', exact: true })
    .click()
  await expect(page).toHaveURL(/\/admin$/)
  await page.goto('/admin/email')
  await page.getByLabel('Subject', { exact: true }).fill('Staging campaign')
  await page
    .getByLabel('Message', { exact: true })
    .fill('Record-only campaign fixture')
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /Queue for/ }).click()
  await page
    .getByRole('link', { name: 'Open campaign delivery progress' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Email operations', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('record-only', { exact: false }).first(),
  ).toBeVisible()
  await expect(page.getByText('No messages match.')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Staging campaign', exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: 'test-results/system-email-desktop.png',
    fullPage: true,
  })
  await page.getByText('Delivery mode controls', { exact: true }).click()
  await page.getByLabel('Email mode', { exact: true }).selectOption('live')
  await page
    .getByLabel('Explanation', { exact: true })
    .first()
    .fill('Fixture attempt must stay disabled')
  await page.getByRole('button', { name: 'Save mode', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Delivery remains off')
})
test('mobile System Admin keeps navigation and real empty states usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await admin(page)
  await page.goto('/admin/system/incidents')
  await expect(
    page.getByRole('heading', { name: 'Errors and incidents', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'Open admin menu' }).click()
  for (const name of ['Status', 'Activity log', 'Email', 'Advanced details'])
    await expect(page.getByRole('link', { name, exact: true }).last()).toBeVisible()
  await page.goto('/admin/system/integrity')
  await expect(
    page.getByText('No integrity checks recorded.', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: 'test-results/system-mobile.png',
    fullPage: true,
  })
})

test('a lost pick response reconciles the saved receipt without a duplicate submission',async({page,request})=>{
 await request.post('/api/auth/login',{data:{email:'player+test@example.test',password:'FixturePass123!'}})
 await page.context().addCookies((await request.storageState()).cookies)
 let posts=0,reconciled=false
 page.on('request',req=>{if(req.url().includes('/api/picks?request_id='))reconciled=true})
 await page.route('**/api/picks',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort('failed')}else await route.continue()})
 await page.goto('/pick')
 await page.getByRole('radio').first().click()
 await page.getByRole('button',{name:'Submit pick'}).first().click()
 const receipt = page.getByRole('complementary', { name: 'Your pick' })
 await expect(receipt.getByText(/^Pick saved:/)).toBeVisible()
 await expect(receipt.getByText(/^Change until /)).toBeVisible()
 expect(posts).toBe(1);expect(reconciled).toBe(true)
 expect((await (await request.get(`${FIXTURE_DB}/picks`)).json()).length).toBe(1)
})
