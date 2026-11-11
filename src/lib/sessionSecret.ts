// SESSION_SECRET signs player/admin sessions, test-mode cookies and
// unsubscribe links. This module is dependency-free (no `server-only`) so the
// proxy and the unit tests can use it. It never logs or returns the value.
//
// Validation is lazy: it runs when a request needs to sign or verify, never at
// import or build time, so `next build` with a placeholder still succeeds and a
// weak deployed secret fails closed per request rather than crashing the app.

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
const reported = new Set<string>()
function reportOnce(level: 'warn' | 'error', message: string) {
  if (reported.has(level + message)) return
  reported.add(level + message)
  console[level](message)
}

// Enforcement applies to production builds (Vercel production and preview,
// `next start`). Development and the browser-test server only require the
// value to be present. SESSION_SECRET_ENFORCEMENT=warn is a temporary rollout
// escape hatch: it logs the problem and keeps signing with the weak value.
export function readSessionSecret(env: Env = process.env): string {
  const value = env.SESSION_SECRET
  if (!value) throw new SessionSecretError('SESSION_SECRET is not set')
  if (env.NODE_ENV !== 'production') return value
  const problem = sessionSecretProblem(value)
  if (!problem) return value
  if (env.SESSION_SECRET_ENFORCEMENT === 'warn') {
    reportOnce('warn', `${problem} (SESSION_SECRET_ENFORCEMENT=warn: continuing; rotate the secret and remove the flag)`)
    return value
  }
  reportOnce('error', `${problem} Requests that need a signed session are refused until it is fixed.`)
  throw new SessionSecretError(problem)
}

export function sessionSecretKey(env: Env = process.env): Uint8Array {
  return new TextEncoder().encode(readSessionSecret(env))
}
