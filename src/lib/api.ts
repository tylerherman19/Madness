import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getAdminSession } from './session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// Request bodies that are not a JSON object are client errors. Parsing them
// must never throw into a route's catch block, where serverError() would open
// an incident, write an audit row and queue an organizer alert for a request
// anyone can send without signing in (SEC-05). Returns null for invalid JSON,
// arrays, primitives and null.
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

// SEC-09: admin responses carry a rule message the database raised on purpose
// (RAISE EXCEPTION, code P0001) but never raw driver/constraint text, which
// can name tables, columns and values.
export function adminDbMessage(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  return error?.code === 'P0001' && error.message ? error.message : fallback
}

export const INVALID_REQUEST = { error: 'Invalid request' } as const

// Escape LIKE/ILIKE wildcards so user input used in .ilike() matches
// literally — otherwise a name like "T%" would match any player starting
// with T. PostgREST also treats `*` as an alias for `%` in like/ilike
// patterns, so it has to be escaped too; without it a value of "*" still
// matches every row.
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_*]/g, '\\$&')
}

// Returns a 401 response for non-admins, null when authorized.
export async function requireAdmin(): Promise<NextResponse | null> {
  if (await getAdminSession()) return null
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// True when the request carries the Vercel Cron secret. CRON_SECRET must
// actually be set — otherwise "Bearer undefined" would match.
export function isCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  // SEC-09: constant-time comparison. Both sides are hashed first because
  // timingSafeEqual throws on unequal lengths, which would turn any wrong
  // header into an unauthenticated 500.
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(req.headers.get('authorization') ?? ''), digest(`Bearer ${secret}`))
}

// Cron endpoints split by method. GET is what Vercel Cron sends and accepts
// only the cron secret (always runs against production — no cookies). Admins
// run the same jobs with POST: the admin cookie is SameSite=Lax, which a
// browser attaches to a cross-site GET navigation but never to a cross-site
// POST, so a link planted somewhere can't trigger a job as the admin.
export function requireCron(req: NextRequest): NextResponse | null {
  if (isCronRequest(req)) return null
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
