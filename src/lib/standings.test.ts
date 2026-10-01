import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBySeedTotal, seedTotalsByPlayer, standingsComparator } from './standings.ts'
import type { StandingRow } from '../types/index.ts'

const row = (name: string, seedTotal: number, survived = 2): StandingRow => ({
  player_id: name,
  full_name: name,
  status: 'alive',
  slates_survived: survived,
  seed_total: seedTotal,
  current_pick: null,
  current_picks: [],
  pick_locked: false,
  pick_revealed: false,
  elimination_reason: null,
})

test('seed totals accumulate every tournament pick', () => {
  assert.deepEqual(seedTotalsByPlayer([
    { player_id: 'a', seed: 12 },
    { player_id: 'a', seed: 7 },
    { player_id: 'a', seed: null },
    { player_id: 'b', seed: 3 },
  ]), { a: 19, b: 3 })
})

test('standings put the highest seed total first', () => {
  const sorted = [row('Low', 4, 8), row('High', 19, 2), row('Middle', 11, 5)].sort(compareBySeedTotal)
  assert.deepEqual(sorted.map((entry) => entry.full_name), ['High', 'Middle', 'Low'])
})

test('the configured tiebreaker decides how survivors are ranked', () => {
  const rows = [row('bea', 4, 9), row('Cal', 19, 2), row('Abe', 11, 5)]
  const order = (tiebreaker: 'seed-total' | 'most-survived' | 'none') =>
    rows.slice().sort(standingsComparator(tiebreaker)).map((entry) => entry.full_name)
  assert.deepEqual(order('seed-total'), ['Cal', 'Abe', 'bea'])
  assert.deepEqual(order('most-survived'), ['bea', 'Abe', 'Cal'])
  assert.deepEqual(order('none'), ['Abe', 'bea', 'Cal'])
})

test('a seed-total pool with no seeds yet ranks by game days survived', () => {
  const rows = [row('Short', 0, 3), row('Long', 0, 8)]
  assert.deepEqual(rows.sort(standingsComparator('seed-total')).map((entry) => entry.full_name), ['Long', 'Short'])
})
