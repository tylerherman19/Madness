import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { SessionSecretError, readSessionSecret, sessionSecretProblem, sessionSecretStatus } from './sessionSecret.ts'

const strong = randomBytes(32).toString('base64')
const quiet = <T>(fn: () => T): T => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return fn() } finally { console.warn = warn; console.error = error }
}

test('strong random secrets are accepted everywhere', () => {
  for (let i = 0; i < 200; i++) assert.equal(sessionSecretProblem(randomBytes(32).toString('base64')), null)
  for (let i = 0; i < 200; i++) assert.equal(sessionSecretProblem(randomBytes(24).toString('hex')), null)
  for (let i = 0; i < 2000; i++) assert.equal(sessionSecretProblem(randomBytes(16).toString('hex')), null)
  assert.equal(readSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: strong }), strong)
})

const weak = [
  'short-secret',
  'ci-placeholder-secret',
  'x'.repeat(40),
  'abababababababababababababababababab',
  'ci-placeholder-secret-at-least-32-characters-long',
  'fixture-only-signing-secret-at-least-32-characters',
  'please-change-me-before-going-live-2026',
  'your-secret-here-your-secret-here-0123',
]

test('weak secrets keep working by default and warn once without leaking the value', () => {
  const messages: string[] = []
  const { warn } = console
  console.warn = (message: string) => { messages.push(message) }
  try {
    for (const value of weak) assert.equal(readSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: value }), value)
    assert.equal(readSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'x', SESSION_SECRET_ENFORCEMENT: 'warn' }), 'x')
  } finally { console.warn = warn }
  assert.equal(messages.length, 1, 'one warning per server instance')
  for (const value of weak) assert.equal(messages[0].includes(value), false)
  assert.throws(() => readSessionSecret({ NODE_ENV: 'production' }), SessionSecretError)
})

test('SESSION_SECRET_ENFORCEMENT=enforce (any case) refuses weak secrets with a message that never contains the value', () => {
  for (const mode of ['enforce', 'ENFORCE', ' Enforce ']) {
    for (const value of weak) {
      assert.throws(() => quiet(() => readSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: value, SESSION_SECRET_ENFORCEMENT: mode })), (error: unknown) =>
        error instanceof SessionSecretError && !error.message.includes(value))
    }
    assert.equal(readSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: strong, SESSION_SECRET_ENFORCEMENT: mode }), strong)
  }
  assert.throws(() => readSessionSecret({ NODE_ENV: 'development' }), SessionSecretError)
})

test('development accepts fixture secrets and the health status is only ok or weak', () => {
  assert.equal(readSessionSecret({ NODE_ENV: 'development', SESSION_SECRET: 'short' }), 'short')
  assert.equal(readSessionSecret({ NODE_ENV: 'test', SESSION_SECRET: 'short' }), 'short')
  assert.equal(sessionSecretStatus({ SESSION_SECRET: strong }), 'ok')
  assert.equal(sessionSecretStatus({ SESSION_SECRET: 'short' }), 'weak')
  assert.equal(sessionSecretStatus({}), 'weak')
})
