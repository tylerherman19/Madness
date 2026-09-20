import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBySeedTotal, seedTotalsByPlayer, slatesSurvivedByPlayer } from './standings.ts'
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

test('slates survived counts playing days, not pick rows', () => {
  // A round quota spent twice on one day is still one day entered.
  assert.deepEqual(slatesSurvivedByPlayer([
    { player_id: 'a', slate_id: 'thursday' },
    { player_id: 'a', slate_id: 'thursday' },
    { player_id: 'a', slate_id: 'friday' },
    { player_id: 'b', slate_id: 'thursday' },
  ]), { a: 2, b: 1 })
})

test('slates survived is empty when nobody has picked', () => {
  assert.deepEqual(slatesSurvivedByPlayer([]), {})
})
