import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 72

export function passwordValidationError(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`
  }
  return null
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// Organizer-generated password reset links (no email). The link is shown once
// to the signed-in organizer; only the SHA-256 hash of the token is stored.
export const RESET_LINK_MINUTES = 60
export const RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/

export function newResetToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// The token travels in the URL fragment, which browsers never send to the
// server, so it stays out of request logs, proxies and Referer headers.
export function resetLinkUrl(base: string, token: string): string {
  const url = new URL('/reset-password', base)
  url.hash = `token=${token}`
  return url.toString()
}

// PostgREST (PGRST202) or PostgreSQL (42883): the 032 function is not installed yet.
export function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}
