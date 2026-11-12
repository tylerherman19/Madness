import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentGuard, validReason } from './slateGuard.ts'

test('change is blocked only when locked, unassigned and entries lack picks', () => {
  assert.equal(assignmentGuard({ locked: true, unpicked: 2, autoAssignCompleted: false }).blocked, true)
  assert.equal(assignmentGuard({ locked: false, unpicked: 2, autoAssignCompleted: false }).blocked, false)
  assert.equal(assignmentGuard({ locked: true, unpicked: 2, autoAssignCompleted: true }).blocked, false)
  assert.equal(assignmentGuard({ locked: true, unpicked: 0, autoAssignCompleted: false }).blocked, false)
  assert.match(assignmentGuard({ locked: true, unpicked: 1, autoAssignCompleted: false }).message!, /Run Auto-Assign first/)
})
test('reason must be 3-500 characters after trimming', () => {
  assert.equal(validReason('  ok  '), null)
  assert.equal(validReason(' fix day '), 'fix day')
  assert.equal(validReason(undefined), null)
  assert.equal(validReason('x'.repeat(501)), null)
})
