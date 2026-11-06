import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeNext } from './safeNext.ts'

test('safeNext follows same-site paths only', () => {
  assert.equal(safeNext('/notifications'), '/notifications')
  assert.equal(safeNext('/sweat?day=3'), '/sweat?day=3')
  assert.equal(safeNext(null), '/pick')
  assert.equal(safeNext(''), '/pick')
  assert.equal(safeNext('https://evil.example'), '/pick')
  assert.equal(safeNext('//evil.example'), '/pick')
  assert.equal(safeNext('/\\evil.example'), '/pick')
  assert.equal(safeNext('/x\n'), '/pick')
  assert.equal(safeNext('javascript:alert(1)'), '/pick')
})
