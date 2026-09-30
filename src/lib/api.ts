import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { getAdminSession } from './session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

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
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
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
