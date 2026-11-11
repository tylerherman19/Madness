// SESSION_SECRET signs player/admin sessions, test-mode cookies and
// unsubscribe links. This module is dependency-free (no `server-only`) so the
// proxy and the unit tests can use it. It never logs or returns the value.
//
// Validation is lazy (per request, never at import or build time). By default a
// weak secret only warns; refusal needs SESSION_SECRET_ENFORCEMENT=enforce.

export const MIN_SESSION_SECRET_LENGTH = 32

// Whole words that only appear in hand-typed placeholder values. Each is at
// least five characters so a random base64 secret cannot plausibly contain one.
const PLACEHOLDER_WORDS = [
  'changeme', 'change-me', 'change_me', 'placeholder', 'replaceme', 'replace-me', 'replace_me',
  'your-secret', 'your_secret', 'yoursecret', 'secret-here', 'secret_here', 'example', 'dummy',
  'fixture-only', 'not-a-secret', 'insecure', 'password', 'qwerty', '12345678', 'abcdefgh',
]

export class SessionSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionSecretError'
  }
}

// Returns a non-secret description of what is wrong, or null when acceptable.
export function sessionSecretProblem(value: string | undefined | null): string | null {
  if (!value) return 'SESSION_SECRET is not set'
  if (value.length < MIN_SESSION_SECRET_LENGTH) {
    return `SESSION_SECRET is too short for production (minimum ${MIN_SESSION_SECRET_LENGTH} characters). Generate one with: openssl rand -base64 32`
  }
  const lower = value.toLowerCase()
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word)) || new Set(value).size < 6) {
    return 'SESSION_SECRET looks like a placeholder, not a random value. Generate one with: openssl rand -base64 32'
  }
  return null
}

type Env = Record<string, string | undefined>
let warned = false
function warnOnce(message: string) {
  if (warned) return
  warned = true
  console.warn(message)
}

export const sessionSecretEnforced = (env: Env = process.env): boolean =>
  env.SESSION_SECRET_ENFORCEMENT?.trim().toLowerCase() === 'enforce'

// 'ok' or 'weak' only: never the value or its length. A missing secret is 'weak'.
export function sessionSecretStatus(env: Env = process.env): 'ok' | 'weak' {
  return sessionSecretProblem(env.SESSION_SECRET) ? 'weak' : 'ok'
}

// Default: a weak production secret logs one warning per server instance and
// keeps working exactly as before. Only SESSION_SECRET_ENFORCEMENT=enforce
// refuses it. Development and the browser-test server only need a value.
export function readSessionSecret(env: Env = process.env): string {
  const value = env.SESSION_SECRET
  if (!value) throw new SessionSecretError('SESSION_SECRET is not set')
  if (env.NODE_ENV !== 'production') return value
  const problem = sessionSecretProblem(value)
  if (!problem) return value
  if (sessionSecretEnforced(env)) throw new SessionSecretError(problem)
  warnOnce(`${problem} (continuing with the current value; set SESSION_SECRET_ENFORCEMENT=enforce once it is rotated to refuse weak secrets)`)
  return value
}

export function sessionSecretKey(env: Env = process.env): Uint8Array {
  return new TextEncoder().encode(readSessionSecret(env))
}
