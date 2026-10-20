import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

// Per-player unsubscribe links. A link carries the player id and an HMAC of
// it, so it works without logging in and can't be forged for someone else.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://madness-cyan.vercel.app'

function sign(playerId: string): string {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET env var is not set')
  return createHmac('sha256', secret).update(`unsubscribe:${playerId}`).digest('base64url')
}

export function verifyUnsubscribe(playerId: unknown, token: unknown): playerId is string {
  if (typeof playerId !== 'string' || typeof token !== 'string' || !playerId || !token) return false
  const expected = Buffer.from(sign(playerId))
  const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

function query(playerId: string): string {
  return `p=${encodeURIComponent(playerId)}&t=${sign(playerId)}`
}

// The page a person lands on from the email link.
export function unsubscribeUrl(playerId: string): string {
  return `${APP_URL}/unsubscribe?${query(playerId)}`
}

// Mail apps' own "Unsubscribe" button (RFC 8058 one-click).
export function unsubscribeHeaders(playerId: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${APP_URL}/api/unsubscribe?${query(playerId)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export function unsubscribeFooter(playerId: string): string {
  return `<p style="margin-top: 28px; font-size: 12px; color: #6B7280;">You get these emails because you joined the Pick and Pray pool. <a href="${unsubscribeUrl(playerId)}" style="color: #6B7280;">Unsubscribe</a></p>`
}
