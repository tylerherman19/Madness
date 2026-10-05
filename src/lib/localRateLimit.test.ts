import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalRateLimiter } from './localRateLimit.ts'

test('fallback denies requests beyond the budget and reopens after expiry', () => {
  const allow = createLocalRateLimiter()
  assert.equal(allow('login:one', 2, 60, 0), true)
  assert.equal(allow('login:one', 2, 60, 1), true)
  assert.equal(allow('login:one', 2, 60, 2), false)
  assert.equal(allow('login:two', 2, 60, 2), true)
  assert.equal(allow('login:one', 2, 60, 60000), true)
})
test('fallback bounds its key storage and reclaims expired budgets', () => {
  const allow = createLocalRateLimiter(1)
  assert.equal(allow('one', 2, 60, 0), true)
  assert.equal(allow('two', 2, 60, 1), false)
  assert.equal(allow('two', 2, 60, 60000), true)
})
