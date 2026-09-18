import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  autoAssignTeam,
  getSlateDeadline,
  isPickRevealed,
  isSlateLocked,
  seedForTeam,
  slateDeadline,
} from './deadline.ts'
import type { Game } from '../types/index.ts'

// A minimal game row. Only the fields the deadline rules read are meaningful;
// the rest exist so the object satisfies Game.
function game(over: Partial<Game> & Pick<Game, 'home_team' | 'away_team' | 'tip_time'>): Game {
  return {
    id: `${over.away_team}@${over.home_team}`,
    slate_id: 'slate-1',
    espn_event_id: `espn:${over.away_team}@${over.home_team}`,
    home_seed: null,
    away_seed: null,
    time_tbd: false,
    round_label: null,
    region: null,
    venue: null,
    tv: null,
    status_state: 'pre',
    period: null,
    display_clock: null,
    home_score: null,
    away_score: null,
    result: 'pending',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

test('the slate locks at its first announced tip', () => {
  const games = [
    game({ away_team: 'KU', home_team: 'BAY', tip_time: '2026-01-24T20:00:00Z' }),
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' }),
    game({ away_team: 'UK', home_team: 'FLA', tip_time: '2026-01-24T23:00:00Z' }),
  ]
  assert.equal(getSlateDeadline(games)?.toISOString(), '2026-01-24T18:00:00.000Z')
})

// A game whose time ESPN hasn't published carries a midnight-Eastern
// placeholder. Reading it as a tip would lock the slate at 11pm Central the
// night before — and, through isPickRevealed, publish picks that can still be
// changed.
test('placeholder tip times never set the deadline', () => {
  const games = [
    game({ away_team: 'GONZ', home_team: 'CREI', tip_time: '2026-01-24T05:00:00Z', time_tbd: true }),
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' }),
  ]
  assert.equal(getSlateDeadline(games)?.toISOString(), '2026-01-24T18:00:00.000Z')
})

test('a slate with nothing announced has no deadline, so nothing locks or reveals', () => {
  const games = [
    game({ away_team: 'GONZ', home_team: 'CREI', tip_time: '2026-01-24T05:00:00Z', time_tbd: true }),
    game({ away_team: 'UCLA', home_team: 'ARIZ', tip_time: '2026-01-24T05:00:00Z', time_tbd: true }),
  ]
  const wellAfter = new Date('2026-01-25T12:00:00Z')

  assert.equal(getSlateDeadline(games), null)
  assert.equal(isSlateLocked(null, games, wellAfter), false)
  assert.equal(isPickRevealed(null, games, wellAfter), false)
})

test('a missing tip_time is ignored rather than read as "never locks"', () => {
  const games = [
    game({ away_team: 'MICH', home_team: 'OSU', tip_time: undefined as unknown as string }),
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' }),
  ]
  assert.equal(getSlateDeadline(games)?.toISOString(), '2026-01-24T18:00:00.000Z')
})

test("the slate's cached lock wins over the games, unless it is unusable", () => {
  const games = [game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' })]

  assert.equal(
    slateDeadline({ locks_at: '2026-01-24T17:30:00Z' }, games)?.toISOString(),
    '2026-01-24T17:30:00.000Z'
  )
  assert.equal(slateDeadline({ locks_at: null }, games)?.toISOString(), '2026-01-24T18:00:00.000Z')
  assert.equal(slateDeadline({ locks_at: 'not a date' }, games)?.toISOString(), '2026-01-24T18:00:00.000Z')
})

test('picks lock and reveal at the same instant', () => {
  const games = [game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' })]
  const slate = { locks_at: '2026-01-24T18:00:00Z' }

  assert.equal(isSlateLocked(slate, games, new Date('2026-01-24T17:59:59Z')), false)
  assert.equal(isPickRevealed(slate, games, new Date('2026-01-24T17:59:59Z')), false)
  // The lock instant itself is closed, not open.
  assert.equal(isSlateLocked(slate, games, new Date('2026-01-24T18:00:00Z')), true)
  assert.equal(isPickRevealed(slate, games, new Date('2026-01-24T18:00:00Z')), true)
})

// Outside the bracket ESPN's curatedRank is the AP poll position. Letting it
// through as a seed would corrupt the seed-total tiebreak.
test('a seed is only a seed inside a labelled tournament round', () => {
  const pollRanked = [
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z', away_seed: 20 }),
  ]
  assert.equal(seedForTeam('DUKE', pollRanked), null)

  const bracket = [
    game({
      away_team: 'DUKE',
      home_team: 'UNC',
      tip_time: '2026-03-19T18:00:00Z',
      away_seed: 12,
      home_seed: 5,
      round_label: '1st Round',
    }),
  ]
  assert.equal(seedForTeam('DUKE', bracket), 12)
  assert.equal(seedForTeam('UNC', bracket), 5)
  assert.equal(seedForTeam('KU', bracket), null)
})

test('auto-assign takes the away side of the latest game the player still has', () => {
  const games = [
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' }),
    game({ away_team: 'KU', home_team: 'BAY', tip_time: '2026-01-24T23:00:00Z' }),
  ]

  assert.equal(autoAssignTeam(games, []), 'KU')
  // Away side spent, so the home side of that same late game is next.
  assert.equal(autoAssignTeam(games, ['KU']), 'BAY')
  // Whole late game spent — walk back to the earlier one.
  assert.equal(autoAssignTeam(games, ['KU', 'BAY']), 'DUKE')
  // Every team on the slate spent: the one case that eliminates.
  assert.equal(autoAssignTeam(games, ['KU', 'BAY', 'DUKE', 'UNC']), null)
})

test('auto-assign skips games with no usable tip time', () => {
  const games = [
    game({ away_team: 'MICH', home_team: 'OSU', tip_time: 'garbage' }),
    game({ away_team: 'DUKE', home_team: 'UNC', tip_time: '2026-01-24T18:00:00Z' }),
  ]
  assert.equal(autoAssignTeam(games, []), 'DUKE')
})
