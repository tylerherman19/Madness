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
test('INT-03: the reserved test-account domain is refused in any case, with subdomains or a trailing dot', async () => {
  const { isReservedTestEmail } = await import('./signupValidation.ts')
  for (const email of ['a@nflsurvivor.internal', 'A@NFLSurvivor.Internal', 'a@x.nflsurvivor.internal', ' a@nflsurvivor.internal. ']) {
    assert.ok(isReservedTestEmail(email), email)
    assert.match(signupValidationError({ ...valid, email: email.trim() }) ?? '', /cannot be used/)
  }
  for (const email of ['a@nflsurvivor.internal.example.com', 'nflsurvivor.internal@example.com', 'a@example.com']) assert.equal(isReservedTestEmail(email), false, email)
})
