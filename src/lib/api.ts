import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { getAdminSession } from './session'

export { isIsoDate, isClockTime } from './validation'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// Parse a JSON object body without throwing. Malformed JSON, arrays and
// primitives all come back as null so routes can answer 400 rather than
// falling into their generic 500 handler.
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

export function badRequest(message = 'Invalid request body'): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 })
}

// Log the real database/driver error server-side and return a generic message.
// Raw PostgREST messages name tables, columns and constraints; they are for
// the logs, not the browser.
export function serverError(context: string, err: unknown, message = 'Something went wrong. Try again.'): NextResponse {
  console.error(context, err)
  return NextResponse.json({ error: message }, { status: 500 })
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
