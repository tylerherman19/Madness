import 'server-only'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { supabase } from './supabase'
import { getDb } from './testMode'
import { cache } from 'react'
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import type { SessionPayload } from '@/types'
import { isTestMode } from './testMode'

const SESSION_COOKIE = 'survivor_session'
const ADMIN_COOKIE = 'survivor_admin'

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET
  if (!s) throw new Error('SESSION_SECRET env var is not set')
  return new TextEncoder().encode(s)
}

function environmentAudience(): string {
  return `madness:${process.env.VERCEL_ENV ?? 'local'}`
}
function credentialVersion(hash: string): string {
  return createHmac('sha256', getSecret()).update(hash).digest('hex')
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
  // Stamp the environment: a session created in the testing sandbox holds a
  // sandbox player_id, which must never resolve against production (and vice
  // versa). getSession() rejects sessions whose stamp doesn't match.
  const test_mode = await isTestMode()
  const db = await getDb()
  const { data: player, error } = await db.from('players').select('pin_hash').eq('id', payload.player_id).single()
  if (error || !player) throw new Error('Cannot create session')
  const token = await new SignJWT({ ...payload, test_mode, purpose: 'player', credential_version: credentialVersion(player.pin_hash) }).setJti(randomUUID())
    .setIssuer('madness').setAudience(environmentAudience()).setIssuedAt()
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expires)
    .sign(getSecret())

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/',
  })
}

export async function createAdminSession(): Promise<void> {
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000) // 8 hours
  const token = await new SignJWT({ is_admin: true, purpose: 'admin' }).setJti(randomUUID())
    .setIssuer('madness').setAudience(environmentAudience()).setIssuedAt()
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expires)
    .sign(getSecret())

  const cookieStore = await cookies()
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/',
  })
}

export const getSession = cache(async (): Promise<SessionPayload | null> => {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: 'madness', audience: environmentAudience() })
    // Sessions are scoped to the environment they were created in — a sandbox
    // session is invisible in production and vice versa.
    if ((payload.test_mode === true) !== (await isTestMode())) return null
    if (await isRevoked(token)) return null
    if (payload.purpose !== 'player' || typeof payload.player_id !== 'string' || typeof payload.credential_version !== 'string') return null
    const db = await getDb()
    const { data: player, error } = await db.from('players').select('pin_hash').eq('id', payload.player_id).maybeSingle()
    if (error || !player) return null
    const expected = Buffer.from(credentialVersion(player.pin_hash))
    const actual = Buffer.from(payload.credential_version)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    return payload as unknown as SessionPayload
  } catch {
    return null
  }
})

export async function getAdminSession(): Promise<boolean> {
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: 'madness', audience: environmentAudience() })
    // Player sessions are signed with the same secret, so a valid signature is
    // not enough — require the is_admin claim that only createAdminSession sets.
    if (await isRevoked(token)) return false
    return payload.is_admin === true && payload.purpose === 'admin'
  } catch {
    return false
  }
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies()
  await revoke(cookieStore.get(SESSION_COOKIE)?.value)
  cookieStore.delete(SESSION_COOKIE)
}

export async function deleteAdminSession(): Promise<void> {
  const cookieStore = await cookies()
  await revoke(cookieStore.get(ADMIN_COOKIE)?.value)
  cookieStore.delete(ADMIN_COOKIE)
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
// A shared public registry prevents a sandbox toggle from resurrecting a revoked admin cookie.
async function isRevoked(token: string): Promise<boolean> {
  const { data, error } = await supabase.from('revoked_sessions').select('token_hash').eq('token_hash', tokenHash(token)).maybeSingle()
  if (error) throw error
  return Boolean(data)
}
async function revoke(token: string | undefined): Promise<void> {
  if (!token) return
  let expires: number | undefined
  try {
    const verified = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: 'madness', audience: environmentAudience() })
    expires = verified.payload.exp
  } catch { return }
  if (!expires) return
  const { error } = await supabase.from('revoked_sessions').upsert({ token_hash: tokenHash(token), expires_at: new Date(expires * 1000).toISOString() })
  if (error) throw error // Never claim a copied cookie was revoked if persistence failed.
}
export async function adminSessionId(): Promise<string | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value
  if (!token || !await getAdminSession()) return null
  return tokenHash(token).slice(0, 16)
}
