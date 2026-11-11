import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FALLBACK_TIME_ZONE, autoAssignHighestSeed, didPickWin, formatClock, isSlateLocked, resolveTimeZone } from './deadline.ts'
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

test('an earlier game overrides a later stored deadline', () => {
  const early = game('early', 'A', null, 'B', null)
  early.tip_time = '2027-03-18T16:00:00Z'
  assert.equal(isSlateLocked({ locks_at: '2027-03-18T17:00:00Z' }, [early], new Date('2027-03-18T16:30:00Z')), true)
})

test('an unknown deadline closes mutations without revealing private picks', () => {
  const tbd = { ...game('tbd', 'A', null, 'B', null), time_tbd: true }
  assert.equal(isSlateLocked(null, [tbd], new Date('2027-03-18T16:30:00Z')), true)
})

test('deadlines print in the viewer zone with a short label, and daylight saving follows the deadline date', () => {
  // US clocks changed on 2026-03-08. The offset must come from the deadline's own instant.
  const before = '2026-03-05T23:00:00Z'
  const after = '2026-03-19T21:00:00Z'
  assert.equal(formatClock(before, 'America/Chicago'), '5:00 PM CST')
  assert.equal(formatClock(before, 'America/New_York'), '6:00 PM EST')
  assert.equal(formatClock(after, 'America/Chicago'), '4:00 PM CDT')
  assert.equal(formatClock(after, 'America/New_York'), '5:00 PM EDT')
  assert.equal(formatClock(after, 'America/Los_Angeles'), '2:00 PM PDT')
  assert.equal(formatClock(before, 'America/Los_Angeles'), '3:00 PM PST')
})

test('zones without daylight saving and UTC are labelled correctly across the change', () => {
  for (const instant of ['2026-03-05T23:00:00Z', '2026-03-19T21:00:00Z']) {
    assert.match(formatClock(instant, 'America/Phoenix'), /MST$/)
    assert.match(formatClock(instant, 'Pacific/Honolulu'), /HST$/)
    assert.match(formatClock(instant, 'UTC'), /UTC$/)
  }
  assert.equal(formatClock('2026-03-19T21:00:00Z', 'America/Phoenix'), '2:00 PM MST')
  assert.equal(formatClock('2026-03-19T21:00:00Z', 'Pacific/Honolulu'), '11:00 AM HST')
  assert.equal(formatClock('2026-03-19T21:00:00Z', 'UTC'), '9:00 PM UTC')
})

test('an unknown, empty or missing zone falls back to Central with its label', () => {
  const instant = '2026-03-19T21:00:00Z'
  for (const zone of ['Not/AZone', '', null, undefined, 'x']) {
    assert.equal(formatClock(instant, zone), '4:00 PM CDT')
  }
  assert.equal(resolveTimeZone('Not/AZone'), FALLBACK_TIME_ZONE)
  assert.equal(resolveTimeZone('Asia/Kolkata'), 'Asia/Kolkata')
})

test('the zone label can be left off and a missing or invalid time reads TBD', () => {
  assert.equal(formatClock('2026-03-19T21:00:00Z', 'America/New_York', false), '5:00 PM')
  assert.equal(formatClock(null), 'TBD')
  assert.equal(formatClock('not a date', 'UTC'), 'TBD')
  assert.equal(formatClock(new Date('2026-03-19T21:00:00Z'), 'UTC'), '9:00 PM UTC')
})

test('midnight and noon use the 12-hour clock without a leading zero hour', () => {
  assert.equal(formatClock('2026-01-15T06:00:00Z', 'America/Chicago'), '12:00 AM CST')
  assert.equal(formatClock('2026-01-15T18:00:00Z', 'America/Chicago'), '12:00 PM CST')
})
