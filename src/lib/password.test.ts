import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PASSWORD_LENGTH, passwordValidationError } from './password.ts'

test('players choose a real password rather than a short PIN', () => {
  assert.match(passwordValidationError('1234') ?? '', /at least 8/)
  assert.equal(passwordValidationError('full-court-press'), null)
})

test('bcrypt-compatible password length is bounded', () => {
  assert.match(passwordValidationError('x'.repeat(MAX_PASSWORD_LENGTH + 1)) ?? '', /or fewer/)
})
