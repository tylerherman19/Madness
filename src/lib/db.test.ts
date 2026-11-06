import test from 'node:test'
import assert from 'node:assert/strict'
import { allRows, selectAll } from './db.ts'

test('paged reads retain 1200 rows even when the server caps each response at 500', async () => {
  const rows = Array.from({ length: 1200 }, (_, id) => ({ id }))
  const loaded = await selectAll<{ id: number }>((from, to) => Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 500)), error: null }))
  assert.deepEqual(loaded, rows)
})
test('a later database page error rejects the entire read', async () => {
  await assert.rejects(selectAll(async (from) => {
    if (from > 0) throw new Error('Database read failed')
    return { data: [{ id: 1 }], error: null }
  }))
})

// A stand-in for a supabase-js query builder: it runs only when awaited,
// reports the exact total only when asked through setHeader, and records
// every request it serves.
type FakePage = { data: { id: number }[]; error: null; count: number | null }
type FakeQuery = PromiseLike<FakePage> & { setHeader(name: string, value: string): FakeQuery }
function lazyQuery(run: (counted: boolean) => FakePage): FakeQuery {
  let counted = false
  const query: FakeQuery = {
    setHeader(name, value) { if (name === 'Prefer' && value === 'count=exact') counted = true; return query },
    then(onfulfilled, onrejected) { return Promise.resolve().then(() => run(counted)).then(onfulfilled, onrejected) },
  }
  return query
}
function fakeTable(rows: { id: number }[], cap = 1000, reportedTotal = rows.length) {
  const calls: { from: number; to: number; counted: boolean }[] = []
  const page = (from: number, to: number) => lazyQuery((counted) => {
    calls.push({ from, to, counted })
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: counted ? reportedTotal : null }
  })
  return { page, calls }
}
const ids = (n: number) => Array.from({ length: n }, (_, id) => ({ id }))

test('a counted read fetches the remaining pages without a trailing empty request', async () => {
  const rows = ids(5586)
  const table = fakeTable(rows)
  assert.deepEqual(await selectAll(table.page), rows)
  assert.equal(table.calls.length, 6)
  assert.equal(table.calls[0].counted, true)
})
test('a counted read stays complete when the server caps each response at 500', async () => {
  const rows = ids(1200)
  const table = fakeTable(rows, 500)
  assert.deepEqual(await selectAll(table.page), rows)
  assert.equal(table.calls.length, 3)
})
test('a table that fits in one page costs one request', async () => {
  const table = fakeTable(ids(122))
  assert.equal((await selectAll(table.page)).length, 122)
  assert.equal(table.calls.length, 1)
})
test('a total that disagrees with the pages falls back to reading until an empty page', async () => {
  const rows = ids(1200)
  const table = fakeTable(rows, 1000, 1500)
  assert.deepEqual(await selectAll(table.page), rows)
})
test('one shared query builder is read page by page and stops at the total', async () => {
  const rows = ids(2500)
  const calls: number[] = []
  let range = [0, 0]
  let counted = false
  const builder: FakeQuery & { range(from: number, to: number): FakeQuery } = {
    setHeader() { counted = true; return builder },
    range(from, to) { range = [from, to]; return builder },
    then(onfulfilled, onrejected) {
      return Promise.resolve().then(() => {
        calls.push(range[0])
        return { data: rows.slice(range[0], range[1] + 1), error: null, count: counted ? rows.length : null }
      }).then(onfulfilled, onrejected)
    },
  }
  const { data } = await allRows({ order: () => builder })
  assert.deepEqual(data, rows)
  assert.deepEqual(calls, [0, 1000, 2000])
})
test('a shared builder handed to selectAll is never read in parallel', async () => {
  const rows = ids(2500)
  let range = [0, 0]
  const builder: FakeQuery = {
    setHeader() { return builder },
    then(onfulfilled, onrejected) {
      return Promise.resolve().then(() => ({ data: rows.slice(range[0], range[1] + 1), error: null, count: rows.length })).then(onfulfilled, onrejected)
    },
  }
  const loaded = await selectAll((from, to) => { range = [from, to]; return builder })
  assert.deepEqual(loaded, rows)
})
