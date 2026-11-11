import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INITIAL_ROWS,
  filterByName,
  groupedItems,
  plainItems,
  sortAlive,
  sortOut,
  windowItems,
} from './standingsList.ts'
import type { AliveRow, OutRow } from './standingsRows.ts'

const alive = (name: string, seedTotal = 0, me = false): AliveRow => ({
  id: name, name, me, teams: [], status: 'none', seedTotal,
})
const out = (name: string, seedTotal = 0): OutRow => ({
  id: name, name, out: 'Out', teams: [], losing: null, seedTotal,
})
const many = (count: number) => Array.from({ length: count }, (_, i) => alive(`Entry ${String(i).padStart(4, '0')}`, i % 17))

test('alphabetical order is case-insensitive, puts your entry first and does not mutate the input', () => {
  const input = [alive('bob'), alive('Zed'), alive('alice'), alive('Mia', 0, true)]
  const before = input.map((r) => r.name)
  assert.deepEqual(sortAlive(input, 'alphabetical').map((r) => r.name), ['Mia', 'alice', 'bob', 'Zed'])
  assert.deepEqual(input.map((r) => r.name), before)
})

test('seed-total order puts the highest total first and breaks ties by name (ties fall back to name)', () => {
  const rows = [alive('B', 5), alive('A', 5), alive('C', 9), alive('D', 1, true)]
  assert.deepEqual(sortAlive(rows, 'seeds').map((r) => r.name), ['C', 'A', 'B', 'D'])
  assert.deepEqual(sortOut([out('B', 5), out('A', 5), out('C', 9)], 'seeds').map((r) => r.name), ['C', 'A', 'B'])
})

test('search covers the full list, ignores case and surrounding spaces, and keeps order', () => {
  const rows = sortAlive(many(5000), 'alphabetical')
  const found = filterByName(rows, '  entry 4999 ')
  assert.deepEqual(found.map((r) => r.name), ['Entry 4999'])
  assert.equal(filterByName(rows, '').length, 5000)
  assert.equal(filterByName(rows, 'nobody').length, 0)
  const partial = filterByName(rows, 'entry 49')
  assert.ok(partial.length > 1)
  assert.deepEqual(partial.map((r) => r.name), partial.map((r) => r.name).slice().sort())
})

test('the window renders a bounded prefix and reports the totals', () => {
  for (const size of [1000, 5000]) {
    const items = plainItems(many(size))
    const first = windowItems(items, INITIAL_ROWS)
    assert.equal(first.shown.length, INITIAL_ROWS)
    assert.equal(first.rowsShown, INITIAL_ROWS)
    assert.equal(first.rowsTotal, size)
    // A row's position in the window equals its position in the full list.
    first.shown.forEach((item, i) => assert.equal(item, items[i]))
  }
  const small = windowItems(plainItems(many(7)), INITIAL_ROWS)
  assert.equal(small.shown.length, 7)
  assert.equal(windowItems(plainItems([]), INITIAL_ROWS).shown.length, 0)
})

test('growing the limit shows the next rows without reordering what was already shown', () => {
  const items = plainItems(many(250))
  const a = windowItems(items, 100).shown
  const b = windowItems(items, 200).shown
  const c = windowItems(items, 300).shown
  assert.equal(b.length, 200)
  assert.equal(c.length, 250)
  a.forEach((item, i) => assert.equal(b[i], item))
})

test('grouped windows count entries, not headings, and never end on a heading', () => {
  const groups = [
    { key: 'a', rows: [alive('A1'), alive('A2'), alive('A3')] },
    { key: 'b', rows: [alive('B1'), alive('B2')] },
    { key: 'c', rows: [alive('C1')] },
  ]
  const items = groupedItems(groups)
  assert.equal(items.length, 9)
  const w = windowItems(items, 3)
  assert.equal(w.rowsShown, 3)
  assert.equal(w.rowsTotal, 6)
  assert.equal(w.shown.length, 4)
  assert.equal(w.shown.at(-1)?.type, 'row')
  const w4 = windowItems(items, 4)
  assert.equal(w4.rowsShown, 4)
  assert.equal(w4.shown.length, 6)
  assert.equal(windowItems(items, 6).shown.length, 9)
})
