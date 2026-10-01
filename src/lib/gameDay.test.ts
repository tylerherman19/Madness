import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gameDayOf } from './gameDay.ts'

test('an evening tip belongs to its own calendar day', () => {
  // 7:00 PM CST, Saturday Nov 14
  assert.equal(gameDayOf('2026-11-15T01:00:00Z'), '2026-11-14')
})

test('a tip after midnight Central belongs to the evening before', () => {
  // 10:30 PM PST Saturday = 12:30 AM CST Sunday
  assert.equal(gameDayOf('2026-11-15T06:30:00Z'), '2026-11-14')
  // 5:59 AM CST is still the previous game day
  assert.equal(gameDayOf('2026-11-15T11:59:00Z'), '2026-11-14')
})

test('the game day turns over at 6:00 AM Central', () => {
  assert.equal(gameDayOf('2026-11-15T12:00:00Z'), '2026-11-15')
})

test('stepping back crosses month and year ends', () => {
  // 1:00 AM CST Dec 1 -> Nov 30
  assert.equal(gameDayOf('2026-12-01T07:00:00Z'), '2026-11-30')
  // 2:00 AM CST Jan 1 -> Dec 31 of the previous year
  assert.equal(gameDayOf('2027-01-01T08:00:00Z'), '2026-12-31')
})

test('daylight saving time is applied', () => {
  // 11:30 PM CDT Thursday Mar 18 2027
  assert.equal(gameDayOf('2027-03-19T04:30:00Z'), '2027-03-18')
  // 12:30 AM CDT Friday Mar 19 still belongs to Thursday
  assert.equal(gameDayOf('2027-03-19T05:30:00Z'), '2027-03-18')
  // 11:00 AM CDT Friday Mar 19
  assert.equal(gameDayOf('2027-03-19T16:00:00Z'), '2027-03-19')
})
