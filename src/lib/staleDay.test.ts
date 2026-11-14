import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleDay, longDate } from './staleDay.ts'

test('the active day is fine just after midnight and until the turnover has had time to run', () => {
  assert.equal(staleDay('2026-11-13', new Date('2026-11-14T06:30:00Z')).stale, false) // 12:30 AM Central
  assert.equal(staleDay('2026-11-13', new Date('2026-11-14T09:30:00Z')).stale, false) // 3:30 AM Central
})
test('a day older than today is stale once the turnover should have run', () => {
  const state = staleDay('2026-11-12', new Date('2026-11-14T15:00:00Z'))
  assert.equal(state.stale, true); assert.equal(state.daysBehind, 2)
})
test('today and future days are not stale; no active day is not stale', () => {
  assert.equal(staleDay('2026-11-14', new Date('2026-11-14T15:00:00Z')).stale, false)
  assert.equal(staleDay('2099-01-01', new Date('2026-11-14T15:00:00Z')).stale, false)
  assert.equal(staleDay(null, new Date()).stale, false)
})
test('long date reads naturally', () => assert.equal(longDate('2026-11-12'), 'Thursday, November 12'))
