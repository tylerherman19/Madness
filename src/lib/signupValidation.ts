export const TERMS_VERSION = '2026-10-04'

export type SignupInput = { full_name: string; email: string; phone: string; venmo: string; password: string; terms_accepted: true }
export function signupValidationError(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid signup request'
  const fields = body as Record<string, unknown>
  for (const name of ['full_name', 'email', 'phone', 'venmo', 'password']) {
    if (typeof fields[name] !== 'string' || !(fields[name] as string).trim()) return 'Name, email, phone, Venmo handle, and password are required'
  }
  const { full_name, email, phone, venmo, password } = fields as SignupInput
  if (full_name.trim().length > 80) return 'Name too long (max 80 characters)'
  if (email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Invalid email address'
  if (phone.trim().length > 20 || !/^[+()\d\s.\-]+$/.test(phone.trim()) || phone.replace(/\D/g, '').length < 7) return 'Enter a valid phone number (max 20 characters)'
  if (venmo.trim().length > 50 || !/^@?[a-zA-Z0-9_-]+$/.test(venmo.trim())) return 'Enter a valid Venmo handle (max 50 characters)'
  if (password.length < 8 || password.length > 72 || new TextEncoder().encode(password).length > 72) return 'Password must be 8–72 characters and at most 72 UTF-8 bytes'
  if (fields.terms_accepted !== true) return 'Please agree to the Terms of Use and acknowledge the Privacy Policy'
  return null
}
