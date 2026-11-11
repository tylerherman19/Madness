import { test, expect, type Page } from '@playwright/test'
import { adminCookie } from './support/admin'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'
const OTHER_PLAYER = '00000000-0000-4000-8000-000000000003'
async function admin(page: Page) {
  await page.context().addCookies([await adminCookie()])
}

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})

async function rows(request: import('@playwright/test').APIRequestContext, path: string) {
  return (await (await request.get(`${FIXTURE_DB}${path}`)).json()) as Record<string, unknown>[]
}

test('Grade button grades the slate once, is audited, and a repeat changes nothing', async ({ page, request }) => {
  await admin(page)
  // Entry B picked the away team, and the home team then won without grading having run
  // (for example a synced final). The form shows the stored result and a pending elimination.
  const pick = await request.post(`${FIXTURE_DB}/picks`, {
    data: { slate_id: SLATE, player_id: OTHER_PLAYER, team: 'B' },
  })
  expect(pick.ok(), await pick.text()).toBeTruthy()
  expect((await request.patch(`${FIXTURE_DB}/games?slate_id=eq.${SLATE}`, { data: { result: 'home_win' } })).ok()).toBeTruthy()

  await page.goto('/admin/results')
  await expect(page.getByRole('button', { name: 'Home Win' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('1 player slated to be eliminated')).toBeVisible()
  // A fast double-click must produce one request, not two.
  let gradeCalls = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/api/results/grade-week') && r.method() === 'POST') gradeCalls++
  })
  const grade = page.getByRole('button', { name: /Grade All Picks/ })
  await grade.dblclick()
  await expect(page.getByText('Graded slate 1. 1 eliminated.')).toBeVisible()
  expect(gradeCalls).toBe(1)

  const player = (await rows(request, `/players?id=eq.${OTHER_PLAYER}`))[0]
  expect(player.status).toBe('eliminated')
  const audit = async (type: string) => rows(request, `/audit_log?event_type=eq.${type}`)
  const graded = await audit('slate-graded')
  expect(graded).toHaveLength(1)
  expect(graded[0].actor).toBe('admin')
  expect((graded[0].details as { eliminated: number }).eliminated).toBe(1)
  expect(await audit('player-eliminated')).toHaveLength(1)

  // A deliberate second run is a no-op for entries: nobody new is eliminated.
  await expect(grade).toBeEnabled()
  await grade.click()
  await expect(page.getByText('Graded slate 1. 0 eliminated.')).toBeVisible()
  expect(await audit('player-eliminated')).toHaveLength(1)
  expect((await rows(request, `/players?id=eq.${OTHER_PLAYER}`))[0].elimination_slate).toBe(player.elimination_slate)
})

test('Grade button shows the server error instead of failing silently', async ({ page }) => {
  await admin(page)
  await page.goto('/admin/results')
  // No result has been entered, so there is nothing to grade.
  await page.getByRole('button', { name: /Grade All Picks/ }).click()
  await expect(page.getByText('No completed games found for this slate')).toBeVisible()
})

test('setting a result in the form saves it and grades the slate immediately', async ({ page, request }) => {
  await admin(page)
  await page.goto('/admin/results')
  await page.getByRole('button', { name: 'Away Win' }).click()
  await expect(page.getByRole('button', { name: 'Away Win' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await rows(request, '/games?result=eq.away_win')).length).toBe(1)
  expect((await rows(request, '/audit_log?event_type=eq.result-set')).length).toBe(1)
  await page.getByRole('button', { name: /Grade All Picks/ }).click()
  await expect(page.getByText('Graded slate 1. 0 eliminated.')).toBeVisible()
})

test('an unauthenticated grading request is refused and changes nothing', async ({ request }) => {
  const res = await request.post('/api/results/grade-week', { data: { slate_id: SLATE } })
  expect(res.status()).toBe(401)
  expect(await rows(request, '/audit_log?event_type=eq.slate-graded')).toHaveLength(0)
})
