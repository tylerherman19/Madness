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
