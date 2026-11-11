import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLocalRateLimiter } from './localRateLimit.ts'
import { firstExceeded, loginLimits, resetLinkLimits, writeLimits } from './rateLimitPolicy.ts'

// Same counting semantics as bump_rate_limit (migration 006): every check
// increments, and the request is allowed while the count is within the limit.
function limiter(clock: { now: number }) {
  const allow = createLocalRateLimiter(1_000_000)
  return (key: string, max: number, windowSeconds: number) => ({ allowed: allow(key, max, windowSeconds, clock.now) })
}
const account = (email: string) => createHash('sha256').update(email).digest('hex')
const NAT = '203.0.113.50'

test('300 players behind one campus address can all log in and save a pick within a few minutes', async () => {
  const clock = { now: 0 }
  const check = limiter(clock)
  for (let i = 0; i < 300; i++) {
    clock.now = i * 600 // 300 people over three minutes
    const player = `player-${i}`
    // Login request through the proxy (anonymous write), then the login route.
    assert.equal(await firstExceeded(writeLimits(NAT, null), check), null, `proxy login ${i}`)
    assert.equal(await firstExceeded(loginLimits(account(`${player}@example.test`), NAT), check), null, `login ${i}`)
    // A couple of pick saves and one preference change while signed in.
    for (let j = 0; j < 3; j++) assert.equal(await firstExceeded(writeLimits(NAT, player), check), null, `write ${i}.${j}`)
  }
})

test('20 wrong passwords against one account are throttled, from one address or from many', async () => {
  const clock = { now: 0 }
  const check = limiter(clock)
  const target = account('victim@example.test')
  const fromOne = []
  for (let i = 0; i < 20; i++) fromOne.push(await firstExceeded(loginLimits(target, NAT), check))
  assert.equal(fromOne.filter(limit => limit === null).length, 10)
  assert.match(String(fromOne.at(-1)?.key), /^login-account-network:/)

  const spread = []
  for (let i = 0; i < 60; i++) spread.push(await firstExceeded(loginLimits(account('other@example.test'), `198.51.100.${i}`), check))
  assert.equal(spread.filter(limit => limit === null).length, 30, 'distributed guessing stops at the per-account budget')
  assert.match(String(spread.at(-1)?.key), /^login-account:/)
})

test('one abusive client on a shared network does not block everyone else on it', async () => {
  const clock = { now: 0 }
  const check = limiter(clock)
  // A signed-in client hammering writes is stopped by its personal budget and,
  // because evaluation stops there, never drains the address-wide ceiling.
  let refused = 0
  for (let i = 0; i < 5000; i++) if (await firstExceeded(writeLimits(NAT, 'abuser'), check)) refused++
  assert.equal(refused, 5000 - 120)
  for (let i = 0; i < 200; i++) assert.equal(await firstExceeded(writeLimits(NAT, `neighbour-${i}`), check), null)
  // Someone guessing one account's password exhausts only that account's
  // budget on this address; other people on the address still sign in.
  for (let i = 0; i < 200; i++) await firstExceeded(loginLimits(account('target@example.test'), NAT), check)
  for (let i = 0; i < 100; i++) assert.equal(await firstExceeded(loginLimits(account(`friend-${i}@example.test`), NAT), check), null)
  // An anonymous flood is confined to the anonymous share, so signed-in pick saves continue.
  for (let i = 0; i < 2000; i++) await firstExceeded(writeLimits('192.0.2.9', null), check)
  assert.ok(await firstExceeded(writeLimits('192.0.2.9', null), check))
  assert.equal(await firstExceeded(writeLimits('192.0.2.9', 'player-on-flooded-network'), check), null)
})

test('the address-wide ceilings remain as the outer safeguard', async () => {
  const clock = { now: 0 }
  const check = limiter(clock)
  let allowed = 0
  for (let i = 0; i < 1500; i++) if (!(await firstExceeded(writeLimits(NAT, `p${i}`), check))) allowed++
  assert.equal(allowed, 1200)
  clock.now = 61_000
  assert.equal(await firstExceeded(writeLimits(NAT, 'p0'), check), null, 'budgets reopen after the window')
  let logins = 0
  for (let i = 0; i < 1100; i++) if (!(await firstExceeded(loginLimits(account(`u${i}`), '192.0.2.1'), check))) logins++
  assert.equal(logins, 1000)
})

test('reset-link use is limited per link and per address; malformed tokens count only against the address', async () => {
  const check = limiter({ now: 0 })
  const link = account('a link token')
  const results = []
  for (let i = 0; i < 8; i++) results.push(await firstExceeded(resetLinkLimits(link, NAT), check))
  assert.equal(results.filter(limit => limit === null).length, 5)
  assert.deepEqual(resetLinkLimits(null, NAT).map(limit => limit.key), [`reset-password:${NAT}`])
})
