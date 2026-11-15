// Unit checks for the 2026-11-14 audit fixes (USE-02, REL-03).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickStateOf, pickProgress } from './viewerState.ts'
import { pickWriteError, EARLY_PICK_PENDING } from './pickErrors.ts'

const periods = [{ id: 'd1', round: '2nd Round' }, { id: 'd2', round: '2nd Round' }, { id: 'd3', round: 'Sweet 16' }]
const quota = (round: string | null) => (round === '2nd Round' ? 2 : null)

test('USE-02: one of two picks in a shared round is partial, not saved', () => {
  const progress = pickProgress([{ slateId: 'd1' }], 'd2', periods, quota)
  assert.deepEqual(progress, { made: 1, required: 2 })
  assert.equal(pickStateOf({ hasSlate: true, eliminated: false, locked: false, hasPick: false, ...progress }), 'open')
  assert.equal(pickStateOf({ hasSlate: true, eliminated: false, locked: false, hasPick: true, ...progress }), 'partial')
  const full = pickProgress([{ slateId: 'd1' }, { slateId: 'd2' }], 'd2', periods, quota)
  assert.equal(pickStateOf({ hasSlate: true, eliminated: false, locked: false, hasPick: true, ...full }), 'submitted')
  assert.equal(pickStateOf({ hasSlate: true, eliminated: false, locked: true, hasPick: true, ...progress }), 'locked')
})
test('USE-02: a daily pool needs one pick on the current day only', () => {
  assert.deepEqual(pickProgress([{ slateId: 'd3' }, { slateId: 'old' }], 'd3', periods, quota), { made: 1, required: 1 })
})
test('REL-03: the database refusal for a pending early pick maps to a clear 409, not a server error', () => {
  assert.deepEqual(pickWriteError({ code: 'P0001', message: 'Pick period is not open' }), { status: 409, message: EARLY_PICK_PENDING })
})
test('USE-04: the countdown never adds time for a stale server timestamp, but corrects a slow device', async () => {
  const { countdownOffsetMs } = await import('./clockOffset.ts')
  const device = Date.parse('2099-01-01T12:00:00Z')
  assert.equal(countdownOffsetMs('2099-01-01T11:59:00Z', device), 0, 'stale serverNow: no extra time')
  assert.equal(countdownOffsetMs('2099-01-01T12:02:00Z', device), 120000, 'slow device: moved forward')
  assert.equal(countdownOffsetMs(undefined, device), 0)
  assert.equal(countdownOffsetMs('garbage', device), 0)
})
