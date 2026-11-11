import { test, expect, type Page } from '@playwright/test'
import { adminCookie } from './support/admin'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const SLATE = '00000000-0000-4000-8000-000000000001'
const OTHER_PLAYER = '00000000-0000-4000-8000-000000000003'

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})

async function admin(page: Page) {
  await page.context().addCookies([await adminCookie()])
}
async function rows(request: import('@playwright/test').APIRequestContext, path: string) {
  return (await (await request.get(`${FIXTURE_DB}${path}`)).json()) as Record<string, unknown>[]
}

test('administrator sets a manual result with a reason, sees it marked, and voids a game after seeing who is affected', async ({ page, request }) => {
  // Entry B picked the away team. A second game gives the void something to act on.
  expect((await request.post(`${FIXTURE_DB}/picks`, { data: { slate_id: SLATE, player_id: OTHER_PLAYER, team: 'B' } })).ok()).toBeTruthy()
  expect((await request.post(`${FIXTURE_DB}/games`, { data: {
    slate_id: SLATE, espn_event_id: 'second', home_team: 'C', away_team: 'D', tip_time: '2099-01-01T19:00:00Z', result: 'pending', status_state: 'pre',
  } })).ok()).toBeTruthy()
  await admin(page)
  await page.goto('/admin/results')

  // Manual result: the confirmation shows who is affected before anything is saved.
  const first = page.locator('div.rounded-xl', { has: page.getByText('B @ A', { exact: true }) }).last()
  await first.getByRole('button', { name: 'Home Win' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm result change' })
  await expect(dialog.getByText('1 entry picked B (1 alive) and will be eliminated.')).toBeVisible()
  await dialog.getByLabel('Reason (required)').fill('Official scorer')
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('Manual result: Official scorer')).toBeVisible()
  expect((await rows(request, `/players?id=eq.${OTHER_PLAYER}`))[0].status).toBe('eliminated')

  // Void the other game: the dialog states what happens, then the game shows as voided.
  const second = page.locator('div.rounded-xl', { has: page.getByText('D @ C', { exact: true }) }).last()
  await second.getByRole('button', { name: 'Void game' }).click()
  await expect(dialog.getByText(/0 entries picked C or D/)).toBeVisible()
  await expect(dialog.getByText('Nobody gets a new pick or a longer deadline.')).toBeVisible()
  await dialog.getByLabel('Reason (required)').fill('Postponed')
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('Voided: Postponed')).toBeVisible()
  expect((await rows(request, "/games?result=eq.void")).length).toBe(1)
  expect((await rows(request, '/audit_log?event_type=eq.game-voided')).length).toBe(1)
  expect((await rows(request, '/audit_log?event_type=eq.result-set')).length).toBe(1)

  // Releasing the manual result hands it back to ESPN.
  await first.getByRole('button', { name: 'Release to ESPN' }).click()
  await dialog.getByLabel('Reason (required)').fill('Feed corrected')
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('Manual result: Official scorer')).toHaveCount(0)
  expect((await rows(request, `/games?result_source=eq.espn&result=eq.home_win`)).length).toBe(1)
})

test('unauthenticated result, release, void and impact requests are refused and change nothing', async ({ request }) => {
  const game = (await rows(request, '/games'))[0]
  for (const data of [
    { game_id: game.id, result: 'home_win', reason: 'x1x' },
    { game_id: game.id, action: 'release', reason: 'x1x' },
    { game_id: game.id, action: 'void', reason: 'x1x' },
    { game_id: game.id, action: 'unvoid', reason: 'x1x' },
  ]) expect((await request.post('/api/results', { data })).status()).toBe(401)
  expect((await request.get(`/api/results/impact?game_id=${game.id}`)).status()).toBe(401)
  const after = (await rows(request, '/games'))[0]
  expect(after.result).toBe('pending')
  expect(after.result_source).toBe('espn')
})

test('a reason is required by the server', async ({ page, request }) => {
  await admin(page)
  const game = (await rows(request, '/games'))[0]
  const res = await page.request.post('/api/results', { data: { game_id: game.id, result: 'home_win', reason: '' } })
  expect(res.status()).toBe(400)
  expect((await rows(request, '/games'))[0].result).toBe('pending')
})
