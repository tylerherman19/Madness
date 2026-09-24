import assert from 'node:assert/strict'
import { test } from 'node:test'

import { autoAssignHighestSeed, didPickWin, isSlateLocked } from './deadline.ts'
import type { Game } from '../types/index.ts'

function game(
  id: string,
  awayTeam: string,
  awaySeed: number | null,
  homeTeam: string,
  homeSeed: number | null,
  roundLabel: string | null = '1st Round'
): Game {
  return {
    id,
    slate_id: 'slate',
    espn_event_id: id,
    away_team: awayTeam,
    away_seed: awaySeed,
    home_team: homeTeam,
    home_seed: homeSeed,
    tip_time: '2027-03-18T17:00:00.000Z',
    time_tbd: false,
    round_label: roundLabel,
    region: 'East',
    venue: null,
    tv: null,
    status_state: 'pre',
    period: null,
    display_clock: null,
    home_score: null,
    away_score: null,
    result: 'pending',
    created_at: '2027-03-01T00:00:00.000Z',
  }
}

test('highest-seed auto-pick starts at No. 1 and uses AP rank as the tiebreak', () => {
  const games = [
    game('a', 'DUKE', 1, 'SIENA', 16),
    game('b', 'HOU', 1, 'VERM', 16),
  ]

  assert.equal(autoAssignHighestSeed(games, [], [], { DUKE: 4, HOU: 2 }), 'HOU')
})

test('a used seed value moves the player to the next seed line', () => {
  const games = [
    game('a', 'DUKE', 1, 'SIENA', 16),
    game('b', 'MSU', 2, 'YALE', 15),
  ]

  assert.equal(autoAssignHighestSeed(games, [], [1], { DUKE: 1, MSU: 7 }), 'MSU')
})

test('a previously used team is never assigned again', () => {
  const games = [
    game('a', 'DUKE', 1, 'SIENA', 16),
    game('b', 'HOU', 1, 'VERM', 16),
  ]

  assert.equal(autoAssignHighestSeed(games, ['HOU'], [], { DUKE: 4, HOU: 2 }), 'DUKE')
})

test('late rounds fall back to the best unused team when every available seed value was used', () => {
  const games = [game('a', 'DUKE', 1, 'MSU', 2, 'Final Four')]

  assert.equal(autoAssignHighestSeed(games, [], [1, 2], { DUKE: 4, MSU: 7 }), 'DUKE')
})

test('seed priority does not treat regular-season rankings as tournament seeds', () => {
  const games = [game('a', 'DUKE', 1, 'UNC', 8, null)]

  assert.equal(autoAssignHighestSeed(games, [], [], { DUKE: 1 }), null)
})

test('the next pick opens only when the previous team has a final win', () => {
  const previous = game('early', 'DUKE', null, 'UNC', null, null)
  const pick = { slate_id: previous.slate_id, team: 'DUKE' }
  assert.equal(didPickWin(pick, [previous]), false)
  assert.equal(didPickWin(pick, [{ ...previous, status_state: 'in' }]), false)
  assert.equal(didPickWin(pick, [{ ...previous, status_state: 'post', result: 'away_win' }]), true)
  assert.equal(didPickWin({ ...pick, team: 'UNC' }, [{ ...previous, result: 'away_win' }]), false)
  assert.equal(didPickWin({ ...pick, slate_id: 'another-day' }, [{ ...previous, result: 'away_win' }]), false)
})

test('an early winner can pick until the next day first tips', () => {
  const tomorrow = game('next', 'MSU', null, 'Purdue', null, null)
  tomorrow.tip_time = '2027-03-19T16:00:00.000Z' // 11:00 AM Central
  const next = { locks_at: tomorrow.tip_time }
  assert.equal(isSlateLocked(next, [tomorrow], new Date('2027-03-18T20:00:00.000Z')), false)
  assert.equal(isSlateLocked(next, [tomorrow], new Date('2027-03-19T15:59:59.000Z')), false)
  assert.equal(isSlateLocked(next, [tomorrow], new Date('2027-03-19T16:00:00.000Z')), true)
})
