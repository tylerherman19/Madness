import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickWriteError } from './pickErrors.ts'
import { publicPlayerLabels } from './playerLabels.ts'
import { didPickWin } from './deadline.ts'
import { survivedPeriodsByPlayer } from './survival.ts'
import { createLocalRateLimiter } from './localRateLimit.ts'

test('deadline, quota and concurrent writes produce actionable responses; infrastructure failures still alert', () => {
  for (const code of ['23505', '40001', '40P01', 'PGRST116']) assert.equal(pickWriteError({ code, message: 'conflict' })?.status, 409)
  for (const message of ['Picks are locked or the deadline is unavailable', 'Pick quota reached', 'Team already used', 'This team is unavailable']) assert.equal(pickWriteError({ code: 'P0001', message })?.status, 409)
  assert.equal(pickWriteError({ code: 'P0001', message: 'A previous pick lost; entry is ineligible' })?.status, 403)
  assert.equal(pickWriteError({ code: '08006', message: 'Connection failed' }), null)
  assert.equal(pickWriteError({ code: 'P0001', message: 'Competition rules unavailable or unsupported' }), null)
})
test('duplicate player names have stable unique public labels without exposing email', () => {
  const players = [{ id: 'abcdef1', full_name: 'Tyler' }, { id: 'abcdef2', full_name: 'Tyler' }, { id: 'other', full_name: 'Jane' }]
  const labels = publicPlayerLabels(players)
  assert.notEqual(labels.get('abcdef1'), labels.get('abcdef2'))
  assert.equal(labels.get('other'), 'Jane')
  assert.deepEqual(publicPlayerLabels(players.toReversed()), new Map([...labels].reverse()))
})
test('restoration excuses an old loss while leaving other losses disqualifying', () => {
  assert.equal(didPickWin({ slate_id: 's', team: 'A', loss_excused: true }, []), true)
  assert.equal(didPickWin({ slate_id: 's', team: 'A' }, []), false)
  const games = [{ slate_id: 's', home_team: 'A', away_team: 'B', result: 'away_win' }]
  const periods = { s: { key: 'round', quota: 2 } }
  const picks = [{ player_id: 'p', slate_id: 's', team: 'A', loss_excused: true }, { player_id: 'p', slate_id: 's', team: 'B' }]
  assert.equal(survivedPeriodsByPlayer(picks, games, periods).p, 1)
  picks[0].loss_excused = false
  assert.equal(survivedPeriodsByPlayer(picks, games, periods).p, undefined)
})

test('one source exhausting its account budget cannot exhaust a different source budget', () => {
  const limit = createLocalRateLimiter()
  for (let i = 0; i < 10; i++) assert.equal(limit('login-account-network:account:attacker', 10, 900), true)
  assert.equal(limit('login-account-network:account:attacker', 10, 900), false)
  assert.equal(limit('login-account-network:account:player', 10, 900), true)
})
