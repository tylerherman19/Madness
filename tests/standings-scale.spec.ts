import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { adminCookie } from './support/admin'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()
})

// Entries are added through the fixture database's REST endpoint, in batches.
async function seedEntries(request: APIRequestContext, count: number, eliminated = 0) {
  const pad = (n: number) => String(n).padStart(5, '0')
  for (let start = 0; start < count; start += 500) {
    const rows = []
    for (let i = start; i < Math.min(count, start + 500); i++) {
      rows.push({
        full_name: i === count - 1 ? 'Zelda Findable' : `Entry ${pad(i)}`,
        email: `scale${i}@example.test`,
        pin_hash: 'x',
        status: i < eliminated ? 'eliminated' : 'alive',
        elimination_slate: i < eliminated ? 1 : null,
      })
    }
    const res = await request.post(`${FIXTURE_DB}/players`, { data: rows })
    expect(res.ok(), await res.text()).toBeTruthy()
  }
  await bustCache(request)
}

// Rows added behind the app's back are invisible until the server's contest
// cache is invalidated; an admin result write (no-op: pending -> pending) does that.
async function bustCache(request: APIRequestContext) {
  const cookie = await adminCookie()
  const game = (await (await request.get(`${FIXTURE_DB}/games`)).json())[0]
  const bust = await request.post('/api/results', {
    headers: { Cookie: `${cookie.name}=${cookie.value}` },
    data: { game_id: game.id, result: 'pending', reason: 'Refresh cache' },
  })
  expect(bust.ok(), await bust.text()).toBeTruthy()
}

const aliveTable = (page: Page) => page.getByRole('table', { name: 'Entries still alive' })

async function bodyRows(page: Page) {
  return aliveTable(page).locator('[role=row][aria-rowindex]').evaluateAll((rows) => rows.length - 1) // minus the header row
}

for (const size of [1000, 5000]) {
  test(`standings with ${size} entries render a bounded window, search the full list and expose table semantics`, async ({ page, request }) => {
    test.setTimeout(120_000)
    await seedEntries(request, size, 50)
    await page.goto('/')
    const table = aliveTable(page)
    await expect(table).toBeVisible()

    // Bounded DOM: one page of entries, not all of them (the fixture's own two players are included).
    const initial = await bodyRows(page)
    console.log(`MEASURED size=${size} initial_alive_rows=${initial} total_dom_rows=${await page.locator('[role=row]').count()} dom_nodes=${await page.evaluate(() => document.getElementsByTagName('*').length)}`)
    expect(initial).toBeLessThanOrEqual(100)
    expect(initial).toBeGreaterThan(0)

    // Table semantics, with a name, a full row count and per-row positions.
    await expect(table).toHaveAttribute('aria-rowcount', /^\d+$/)
    const rowCount = Number(await table.getAttribute('aria-rowcount'))
    expect(rowCount).toBeGreaterThanOrEqual(size - 50)
    await expect(table.getByRole('columnheader').first()).toHaveText('Entry')
    await expect(table.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending')
    await expect(table.getByRole('row').nth(1)).toHaveAttribute('aria-rowindex', '2')
    await expect(table.getByRole('cell').first()).toBeVisible()

    // The target entry sorts last, so it is not rendered yet; search still finds it across the full data.
    await expect(table.getByText('Zelda Findable')).toHaveCount(0)
    const searchStarted = Date.now()
    await page.getByLabel('Find an entry').fill('zelda find')
    await expect(table.getByText('Zelda Findable')).toBeVisible()
    const searchMs = Date.now() - searchStarted
    console.log(`MEASURED size=${size} search_to_result_ms=${searchMs}`)
    expect(searchMs).toBeLessThan(1500)
    await expect(page.getByRole('status').filter({ hasText: 'match' })).toContainText('1 of')
    // Its position in the full ordering is reported, not its position in the window.
    const found = table.getByRole('row').filter({ hasText: 'Zelda Findable' })
    await expect(found).toHaveAttribute('aria-rowindex', '2')
    await page.getByLabel('Find an entry').fill('')
    expect(await bodyRows(page)).toBeLessThanOrEqual(100)

    // "Show more" adds a page, keeps focus in the list and keeps rows in order.
    const more = page.getByRole('button', { name: /Show \d+ more alive entries/ })
    await more.focus()
    await page.keyboard.press('Enter')
    expect(await bodyRows(page)).toBeGreaterThan(100)
    expect(await bodyRows(page)).toBeLessThanOrEqual(200)
    await expect(table.locator(':focus')).toHaveAttribute('aria-rowindex', '102')
    const indexes = await table.locator('[role=row][aria-rowindex]').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('aria-rowindex'))))
    expect(indexes).toEqual(indexes.map((_, i) => i + 1))

    // Sorting and the eliminated list use the same window.
    await expect(page.getByRole('table', { name: 'Eliminated entries' }).locator('[role=row][aria-rowindex]')).toHaveCount(51)
    await page.getByRole('tab', { name: 'By team' }).click()
    expect(await bodyRows(page)).toBeLessThanOrEqual(110)

    // No horizontal page overflow on a phone.
    await page.setViewportSize({ width: 375, height: 800 })
    await page.getByRole('tab', { name: 'Alphabetical' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('a search with no match says so and announces zero results', async ({ page, request }) => {
  await seedEntries(request, 30)
  await page.goto('/')
  await page.getByLabel('Find an entry').fill('nobody at all')
  await expect(page.getByText('No match.').first()).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toContainText('0 of')
})

test('the signed-in viewer\'s own entry stays on screen in By team order even past the first page', async ({ page, request }) => {
  await seedEntries(request, 1200)
  const login = await page.context().request.post('/api/auth/login', { data: { email: 'player+test@example.test', password: 'FixturePass123!' } })
  expect(login.ok()).toBeTruthy()
  // Everyone else picks A, the viewer picks B: after lock the one-person B group sorts after the huge A group.
  const mine = await page.context().request.post('/api/picks', { data: { slate_id: '00000000-0000-4000-8000-000000000001', team: 'B' } })
  expect(mine.ok(), await mine.text()).toBeTruthy()
  const players = (await (await request.get(`${FIXTURE_DB}/players?limit=5000`)).json()) as { id: string; email: string }[]
  const others = players.filter((p) => p.email.startsWith('scale'))
  for (let i = 0; i < others.length; i += 500) {
    const res = await request.post(`${FIXTURE_DB}/picks`, {
      data: others.slice(i, i + 500).map((p) => ({ slate_id: '00000000-0000-4000-8000-000000000001', player_id: p.id, team: 'A' })),
    })
    expect(res.ok(), await res.text()).toBeTruthy()
  }
  expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
  await bustCache(request)
  await page.goto('/')
  await page.getByRole('tab', { name: 'By team' }).click()
  const table = aliveTable(page)
  const row = table.getByRole('row').filter({ hasText: /^You/ })
  await expect(row).toHaveCount(1)
  expect(Number(await row.getAttribute('aria-rowindex'))).toBeGreaterThan(100)
  expect(await bodyRows(page)).toBeLessThanOrEqual(102) // 100 entries + group heading + pinned own row
})

test('Show more then a new search then clearing it returns to the first page', async ({ page, request }) => {
  await seedEntries(request, 400)
  await page.goto('/')
  await page.getByRole('button', { name: /Show \d+ more alive entries/ }).click()
  expect(await bodyRows(page)).toBeGreaterThan(100)
  await page.getByLabel('Find an entry').fill('Entry 00')
  await page.getByLabel('Find an entry').fill('')
  expect(await bodyRows(page)).toBeLessThanOrEqual(100)
})
