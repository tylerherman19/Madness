import test from 'node:test'
import assert from 'node:assert/strict'
import { signupValidationError } from './signupValidation.ts'

const valid = { full_name: 'Player Example', email: 'player@example.com', phone: '(608) 555-1234', venmo: '@player-example', password: 'test-password' }
test('signup accepts complete input without a checkbox', () => assert.equal(signupValidationError(valid), null))
test('signup rejects malformed input without throwing', () => {
  for (const body of [null, [], 7, 'name', { ...valid, full_name: {} }, { ...valid, phone: 123 }, { ...valid, password: true }]) {
    assert.ok(signupValidationError(body))
  }
})
test('signup rejects bad contact details and oversized input', () => {
  for (const fields of [{ email: 'bad@' }, { phone: 'invalid' }, { venmo: '<script>' }, { full_name: 'x'.repeat(81) }, { password: 'short' }, { password: '🙂'.repeat(19) }]) {
    assert.ok(signupValidationError({ ...valid, ...fields }))
  }
})
