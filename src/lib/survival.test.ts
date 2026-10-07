import test from 'node:test'
import assert from 'node:assert/strict'
import { survivedPeriodsByPlayer } from './survival.ts'

test('shared-round survival requires every required pick to win', () => {
  const picks = [
    { player_id: 'one', slate_id: 'day1', team: 'A' },
    { player_id: 'one', slate_id: 'day2', team: 'C' },
    { player_id: 'two', slate_id: 'day1', team: 'A' },
    { player_id: 'two', slate_id: 'day2', team: 'D' },
  ]
  const games = [
    { slate_id: 'day1', home_team: 'A', away_team: 'B', result: 'home_win' },
    { slate_id: 'day2', home_team: 'C', away_team: 'D', result: 'home_win' },
  ]
  const periods = { day1: { key: 'round', quota: 2 }, day2: { key: 'round', quota: 2 } }
  assert.deepEqual(survivedPeriodsByPlayer(picks, games, periods), { one: 1 })
  assert.deepEqual(survivedPeriodsByPlayer(picks, [{ ...games[0], result: 'pending' }, games[1]], periods), {})
})
