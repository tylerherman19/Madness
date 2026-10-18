import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { centralClock, orderRecoveryDates } from './operationPolicy.ts'

type SlateFixture = { id: string; slate_number: number; slate_date: string; season_year: number; is_active: boolean; locks_at: string }
type GameFixture = { slate_id: string; result: string }

function fixture(slates: SlateFixture[], games: GameFixture[] = [], pickedIds: string[] = [], failedDates: string[] = []) {
  const synced: string[] = []
  const graded: { id: string; games: GameFixture[] }[] = []
  const checked: string[] = []
  const dependencies: Record<string, unknown> = {
    '@/lib/pool': { getPoolConfig: async () => ({ starts_on: null }) },
    '@/lib/revalidateContest': { revalidateContest() {} },
    'next/server': { NextResponse: { json: Response.json } },
    '@/lib/espnSync': { syncSlateFromEspn: async (_db: unknown, date: string) => {
      synced.push(date)
      return { ok: !failedDates.includes(date) }
    } },
    '@/lib/grading': { gradeSlatePicks: async (_db: unknown, id: string, _number: number, completed: GameFixture[]) => {
      graded.push({ id, games: completed })
      return { eliminated: [], advanced: [] }
    } },
    '@/lib/seasonData': {
      loadAll: async () => slates,
      loadGamesForSlates: async (_db: unknown, ids: string[]) => games.filter(game => ids.includes(game.slate_id)),
      loadPicksForSlates: async (_db: unknown, ids: string[]) => pickedIds.filter(id => ids.includes(id)).map(slate_id => ({ slate_id })),
    },
    '@/lib/alerts': { serverError: async () => Response.json({ error: 'Fixture sync failed' }, { status: 500 }) },
    './operationPolicy': { centralClock, orderRecoveryDates },
  }
  const exports: { syncResults?: (db: unknown, now: Date) => Promise<Response> } = {}
  const code = ts.transpileModule(readFileSync(new URL('./syncResults.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected test dependency: ${name}`)
    return dependencies[name]
  }, exports)
  assert.ok(exports.syncResults)
  const db = { from: (table: string) => {
    assert.equal(table, 'slates')
    return { update: () => ({ eq: async (_column: string, id: string) => {
      checked.push(id)
      return { error: null }
    } }) }
  } }
  return { run: (now: Date) => exports.syncResults!(db, now), synced, graded, checked }
}

const now = new Date('2026-10-18T02:00:00Z') // Still October 17 in Central time.
const future: SlateFixture = { id: 'future', slate_number: 3, slate_date: '2026-10-18', season_year: 2027, is_active: true, locks_at: '2026-10-18T18:00:00Z' }
const overdue: SlateFixture = { id: 'overdue', slate_number: 2, slate_date: '2026-10-16', season_year: 2027, is_active: false, locks_at: '2026-10-16T18:00:00Z' }

test('a future active day skips result polling and grading until its Central calendar day', async () => {
  const state = fixture([future], [{ slate_id: future.id, result: 'home_win' }], [future.id], ['20261018'])
  const response = await state.run(now)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).periods_synced, 0)
  assert.deepEqual(state.synced, [])
  assert.deepEqual(state.graded, [])
  assert.deepEqual(state.checked, [])
})

test('a future active day still allows overdue picked results in its season to recover', async () => {
  const priorSeason = { ...overdue, id: 'prior-season', season_year: 2026 }
  const state = fixture([future, overdue, priorSeason], [
    { slate_id: overdue.id, result: 'pending' },
    { slate_id: overdue.id, result: 'home_win' },
    { slate_id: priorSeason.id, result: 'pending' },
  ], [overdue.id, priorSeason.id])
  const response = await state.run(now)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).periods_synced, 1)
  assert.deepEqual(state.synced, ['20261016'])
  assert.ok(state.graded.length > 0)
  assert.ok(state.graded.every(row => row.id === overdue.id && row.games.every(game => game.result !== 'pending')))
})

test('the current Central playing day is polled and a feed failure still permits old-date processing', async () => {
  const current = { ...future, slate_date: '2026-10-17' }
  const state = fixture([current, overdue], [{ slate_id: overdue.id, result: 'pending' }], [overdue.id], ['20261017'])
  const response = await state.run(now)
  assert.equal(response.status, 500)
  assert.deepEqual(state.synced, ['20261017', '20261016'])
  assert.ok(state.graded.some(row => row.id === overdue.id))
})
