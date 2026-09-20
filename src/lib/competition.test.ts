import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPickPeriods,
  capabilitiesFor,
  normalizeRound,
  roundDisplay,
  roundOrder,
  roundOf64Countdown,
  roundOf64Date,
  seedToShow,
  sharedRoundPickQuota,
  ROUND_SEQUENCE,
  type PickPeriodGame,
  type PickPeriodSource,
} from './competition.ts'

const slate = (id: string, n: number, date: string): PickPeriodSource => ({
  id,
  slate_number: n,
  slate_date: date,
  locks_at: null,
})

const game = (slateId: string, round: string | null): PickPeriodGame => ({
  slate_id: slateId,
  round_label: round,
})

test('capabilities separate the two competitions', () => {
  const regular = capabilitiesFor('regular-season')
  const tournament = capabilitiesFor('march-madness')

  assert.equal(regular.showSeeds, false)
  assert.equal(regular.groupScheduleByRound, false)
  assert.equal(tournament.showSeeds, true)
  assert.equal(tournament.groupScheduleByRound, true)

  // AP poll position and tournament seed are mutually exclusive: the same
  // ESPN field carries both, and showing one as the other is a lie the
  // seed-total tiebreak would then compound.
  assert.notEqual(regular.showPollRank, regular.showSeeds)
  assert.notEqual(tournament.showPollRank, tournament.showSeeds)
})

test('an unknown mode falls back to regular season rather than throwing', () => {
  // @ts-expect-error — deliberately passing a value the enum doesn't cover
  assert.deepEqual(capabilitiesFor('conference-tournament'), capabilitiesFor('regular-season'))
})

test('round labels normalise across ESPN spellings and admin typing', () => {
  assert.equal(normalizeRound('1st Round'), '1st Round')
  assert.equal(normalizeRound('Round of 64'), '1st Round')
  assert.equal(normalizeRound('  first round  '), '1st Round')
  assert.equal(normalizeRound('Elite Eight'), 'Elite 8')
  assert.equal(normalizeRound('Regional Final'), 'Elite 8')
  assert.equal(normalizeRound('Championship'), 'National Championship')

  // Non-tournament games have no round, and neither do labels we don't know.
  assert.equal(normalizeRound(null), null)
  assert.equal(normalizeRound(''), null)
  assert.equal(normalizeRound('Big Ten Quarterfinal'), null)
})

test('round display names are what a fan calls them', () => {
  assert.equal(roundDisplay('1st Round'), 'First Round')
  assert.equal(roundDisplay('2nd Round'), 'Second Round')
  assert.equal(roundDisplay('Elite 8'), 'Elite Eight')
  assert.equal(roundDisplay(null), null)
})

test('rounds order by bracket position', () => {
  const ordered = [...ROUND_SEQUENCE].sort((a, b) => roundOrder(a) - roundOrder(b))
  assert.deepEqual(ordered, [...ROUND_SEQUENCE])
  assert.ok(roundOrder('First Four') < roundOrder('Final Four'))
  // A game with no round sorts last rather than first.
  assert.ok(roundOrder(null) > roundOrder('National Championship'))
})

test('Elite Eight is two picks across the complete round', () => {
  assert.equal(sharedRoundPickQuota('march-madness', 'every-game-day', 'Elite 8'), 2)
  assert.equal(sharedRoundPickQuota('march-madness', 'tournament-round', 'Elite 8'), 2)
})

test('round quotas do not change regular-season game days', () => {
  assert.equal(sharedRoundPickQuota('regular-season', 'tournament-round', null), null)
  assert.equal(sharedRoundPickQuota('march-madness', 'every-game-day', 'Sweet 16'), null)
  assert.equal(sharedRoundPickQuota('march-madness', 'tournament-round', 'Sweet 16'), 2)
})

test('regular-season pick periods are named by their calendar day', () => {
  const periods = buildPickPeriods(
    'regular-season',
    [slate('a', 1, '2027-01-16'), slate('b', 2, '2027-01-18')],
    [game('a', null), game('b', null)]
  )

  assert.equal(periods.length, 2)
  assert.equal(periods[0].label, 'Saturday, January 16')
  assert.equal(periods[0].shortLabel, 'Jan 16')
  assert.equal(periods[0].round, null)
  assert.equal(periods[0].dayInRound, null)
})

test('a date never drifts onto the adjacent day', () => {
  // slate_date is a bare YYYY-MM-DD. Parsed as UTC midnight it would render
  // as the previous day for anyone west of Greenwich.
  const [period] = buildPickPeriods('regular-season', [slate('a', 1, '2027-03-01')], [])
  assert.match(period.label, /March 1$/)
  assert.equal(period.shortLabel, 'Mar 1')
})

test('regular-season mode ignores round labels even when the data has them', () => {
  // A conference tournament game synced in February must not turn the pool
  // into a bracket. Only the administrator's mode choice does that.
  const [period] = buildPickPeriods('regular-season', [slate('a', 1, '2027-01-16')], [game('a', '1st Round')])
  assert.equal(period.round, null)
  assert.equal(period.label, 'Saturday, January 16')
})

test('tournament pick periods are named by round, numbered within it', () => {
  const periods = buildPickPeriods(
    'march-madness',
    [
      slate('thu', 1, '2027-03-18'),
      slate('fri', 2, '2027-03-19'),
      slate('sat', 3, '2027-03-20'),
    ],
    [game('thu', '1st Round'), game('fri', '1st Round'), game('sat', '2nd Round')]
  )

  assert.equal(periods[0].label, 'First Round · Thursday')
  assert.equal(periods[0].dayInRound, 1)
  assert.equal(periods[0].shortLabel, 'R64')

  assert.equal(periods[1].label, 'First Round · Friday')
  assert.equal(periods[1].dayInRound, 2)
  assert.equal(periods[1].shortLabel, 'R64 · D2')

  assert.equal(periods[2].round, '2nd Round')
  assert.equal(periods[2].dayInRound, 1)
})

test('periods are built in calendar order regardless of row order', () => {
  const periods = buildPickPeriods(
    'march-madness',
    [slate('fri', 2, '2027-03-19'), slate('thu', 1, '2027-03-18')],
    [game('thu', '1st Round'), game('fri', '1st Round')]
  )
  assert.deepEqual(periods.map((p) => p.id), ['thu', 'fri'])
  assert.deepEqual(periods.map((p) => p.dayInRound), [1, 2])
})

test('a day straddling two rounds takes the one it mostly belongs to', () => {
  const periods = buildPickPeriods(
    'march-madness',
    [slate('a', 1, '2027-03-19')],
    [game('a', '1st Round'), game('a', '1st Round'), game('a', '2nd Round')]
  )
  assert.equal(periods[0].round, '1st Round')
})

test('an evenly split day takes the earlier round, which is still being picked', () => {
  const periods = buildPickPeriods(
    'march-madness',
    [slate('a', 1, '2027-03-19')],
    [game('a', '2nd Round'), game('a', '1st Round')]
  )
  assert.equal(periods[0].round, '1st Round')
})

test('a tournament day with no labelled games falls back to its date', () => {
  const periods = buildPickPeriods('march-madness', [slate('a', 1, '2027-03-18')], [game('a', null)])
  assert.equal(periods[0].round, null)
  assert.equal(periods[0].label, 'Thursday, March 18')
})

test('seeds only surface inside a bracket', () => {
  // Outside the tournament ESPN's curatedRank is the AP poll position. A #20
  // ranking read as a 20-seed would wreck the seed-total tiebreak.
  assert.equal(seedToShow('regular-season', 2, '1st Round'), null)
  assert.equal(seedToShow('march-madness', 2, '1st Round'), 2)
  assert.equal(seedToShow('march-madness', 2, null), null)
  assert.equal(seedToShow('march-madness', 15, 'Round of 64'), 15)
})

test('out-of-range seeds are rejected rather than rendered', () => {
  // 99 is ESPN's "unranked" sentinel; a bracket has no 0 or 17 seed.
  assert.equal(seedToShow('march-madness', 99, '1st Round'), null)
  assert.equal(seedToShow('march-madness', 0, '1st Round'), null)
  assert.equal(seedToShow('march-madness', 17, '1st Round'), null)
  assert.equal(seedToShow('march-madness', null, '1st Round'), null)
  assert.equal(seedToShow('march-madness', undefined, '1st Round'), null)
  assert.equal(seedToShow('march-madness', 1, '1st Round'), 1)
  assert.equal(seedToShow('march-madness', 16, '1st Round'), 16)
})

test('the round of 64 is the third Thursday of March', () => {
  // The dates the committee has actually scheduled.
  assert.equal(roundOf64Date(2023).toISOString().slice(0, 10), '2023-03-16')
  assert.equal(roundOf64Date(2024).toISOString().slice(0, 10), '2024-03-21')
  assert.equal(roundOf64Date(2025).toISOString().slice(0, 10), '2025-03-20')
  assert.equal(roundOf64Date(2026).toISOString().slice(0, 10), '2026-03-19')
  assert.equal(roundOf64Date(2027).toISOString().slice(0, 10), '2027-03-18')
  assert.equal(roundOf64Date(2028).toISOString().slice(0, 10), '2028-03-16')
})

test('the countdown measures whole Central days to tipoff', () => {
  const countdown = roundOf64Countdown(new Date('2026-09-12T18:00:00Z'), 2027)
  assert.equal(countdown.days, 187)
  assert.equal(countdown.dateLabel, 'March 18, 2027')
  assert.equal(countdown.year, 2027)

  // Late evening Central is still the same Central day, so the count holds
  // even though UTC has already rolled over.
  assert.equal(roundOf64Countdown(new Date('2027-03-18T04:00:00Z'), 2027).days, 1)
  assert.equal(roundOf64Countdown(new Date('2027-03-18T17:00:00Z'), 2027).days, 0)
})

test('a finished tournament rolls the countdown to the next one', () => {
  // The day after this season's round of 64 there is nothing left to count
  // down to — the pool's next first round is a year out.
  const countdown = roundOf64Countdown(new Date('2027-03-19T17:00:00Z'), 2027)
  assert.equal(countdown.year, 2028)
  assert.equal(countdown.dateLabel, 'March 16, 2028')
  assert.ok(countdown.days > 0)
})
