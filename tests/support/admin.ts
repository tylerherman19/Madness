import { SignJWT } from 'jose'

const secret = new TextEncoder().encode('fixture-only-signing-secret-at-least-32-characters')

// A signed admin session cookie for the fixture app (same recipe as tests/admin-reliability.spec.ts).
export async function adminCookie() {
  const value = await new SignJWT({ is_admin: true, purpose: 'admin' })
    .setJti(crypto.randomUUID())
    .setIssuer('madness')
    .setAudience('madness:local')
    .setIssuedAt()
    .setExpirationTime('1h')
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret)
  return { name: 'survivor_admin', value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' as const }
}
