import test from 'node:test'
import assert from 'node:assert/strict'
import { selectAll } from './db.ts'

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
