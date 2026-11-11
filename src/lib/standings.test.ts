import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBySeedTotal, revealedLosingPicks, seedTotalsByPlayer } from './standings.ts'
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

test('a losing pick is listed only after its day reveals and its game is a final loss', () => {
  const slate = { id: 's1', slate_number: 5, locks_at: '2099-03-19T18:00:00.000Z' }
  const game = (result: string) => new Map([['s1', [
    { id: 'g', slate_id: 's1', home_team: 'HOME', away_team: 'AWAY', tip_time: '2099-03-19T18:00:00.000Z', time_tbd: false, result },
  ]]]) as unknown as Parameters<typeof revealedLosingPicks>[3]
  const picks = [{ player_id: 'p', slate_id: 's1', team: 'AWAY' }]
  const out = [{ id: 'p', out: 5 }]
  const before = new Date('2099-03-19T17:00:00.000Z')
  const after = new Date('2099-03-19T19:00:00.000Z')
  // Eliminated by an admin before the lock: the hidden pick stays hidden.
  assert.deepEqual(revealedLosingPicks(out, picks, [slate], game('home_win'), before), {})
  // Locked but not a final, or a game the team won: never shown as lost.
  assert.deepEqual(revealedLosingPicks(out, picks, [slate], game('pending'), after), {})
  assert.deepEqual(revealedLosingPicks(out, picks, [slate], game('away_win'), after), {})
  assert.deepEqual(revealedLosingPicks(out, picks, [slate], game('home_win'), after), { p: ['AWAY'] })
  // A pick on another day than the elimination day is never listed.
  assert.deepEqual(revealedLosingPicks([{ id: 'p', out: 4 }], picks, [slate], game('home_win'), after), {})
})
