import { expect, test } from '@playwright/test'

const fixture = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const saturday = '00000000-0000-4000-8000-000000000027'
const sunday = '00000000-0000-4000-8000-000000000028'

test('Elite Eight takes both selections together and never saves one', async ({ page, request }) => {
  expect((await request.post(`${fixture}/__test/reset`)).ok()).toBeTruthy()
  expect((await request.post(`${fixture}/__test/elite-eight`)).ok()).toBeTruthy()
  try {
    const ready = await request.post(`${fixture}/rest/v1/rpc/march_2027_elite_ready`, { data: { p_anchor: saturday } })
    expect(await ready.text()).toBe('true')
    expect((await page.request.post('/api/auth/login', {
      data: { email: 'player+test@example.test', password: 'FixturePass123!' },
    })).ok()).toBeTruthy()
    await page.goto('/pick')
    await expect(page.getByRole('heading', { name: 'Elite Eight picks' })).toBeVisible()
    const submit = page.getByRole('button', { name: 'Submit both picks' })
    await expect(submit).toBeDisabled()
    await expect(page.getByRole('button', { name: /SAT-A/ })).toBeEnabled()
    await page.getByRole('button', { name: /SAT-A/ }).click()
    await expect(page.getByText('1 of 2 selected')).toBeVisible()
    await expect(submit).toBeDisabled()
    await page.locator('[aria-describedby="elite-submit-hint"]').hover()
    await expect(page.getByRole('tooltip')).toContainText('Submit both before Saturday’s first tip.')
    const short = await page.request.post('/api/picks/elite-eight', {
      data: { request_id: crypto.randomUUID(), picks: [{ slate_id: saturday, team: 'SAT-A' }] },
    })
    expect(short.status()).toBe(400)
    expect(await (await request.get(`${fixture}/picks`)).json()).toEqual([])
    await page.getByRole('button', { name: /SUN-C/ }).click()
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByRole('status')).toContainText('Both picks saved: SAT-A and SUN-C.')
    const rows = await (await request.get(`${fixture}/picks`)).json()
    expect(rows.map((pick: { slate_id: string; team: string }) => [pick.slate_id, pick.team]).sort()).toEqual([[saturday, 'SAT-A'], [sunday, 'SUN-C']])
    await page.reload()
    await expect(page.getByText('2 of 2 selected')).toBeVisible()
  } finally {
    await request.post(`${fixture}/__test/reset`)
  }
})
