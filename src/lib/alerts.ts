import 'server-only'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit } from './audit'
import { getResend, FROM_EMAIL } from './email'
import { supabase as productionDb } from './supabase'
import { getDb } from './testMode'
import type { FailureEventType } from './auditEvents'

// Failure reporting. Every failure lands in the audit log (so /admin/audit
// shows what broke next to what people did) and, for production, texts the
// organizer through an email-to-SMS gateway such as 5551234567@tmomail.net.
//
// Texts are ordinary email: they go through getResend(), so they stay silent
// until EMAILS_ENABLED=true like every other send, and also need ALERT_SMS_TO.
// Sandbox (test mode) failures are logged to the sandbox trail but never text.

// A repeat of the same failure inside this window is not logged again — a
// broken endpoint polled by every open browser would otherwise write a row
// per poll.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000
// At most one text per failure type inside this window.
const TEXT_WINDOW_MS = 30 * 60 * 1000
// SMS gateways split or truncate long mail; keep texts to roughly one SMS.
const SMS_MAX_CHARS = 150

export interface FailureReport {
  kind: FailureEventType
  // Where it happened, e.g. 'cron:sync-results' or 'api:picks'. Also the
  // dedupe key unless `key` is given.
  source: string
  message: string
  error?: unknown
  key?: string
  details?: Record<string, unknown>
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  if (typeof err === 'string') return err
  return err === undefined ? '' : JSON.stringify(err)
}

// Best-effort, like logAudit: reporting a failure must never throw from
// inside the error path that called it.
export async function reportFailure(db: SupabaseClient, report: FailureReport): Promise<void> {
  try {
    const key = report.key ?? report.source
    const errorText = report.error === undefined ? undefined : describeError(report.error).slice(0, 500)
    const now = Date.now()

    const { data: recent } = await db
      .from('audit_log')
      .select('created_at, details')
      .eq('event_type', report.kind)
      .gte('created_at', new Date(now - TEXT_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(200)
    const rows = (recent || []) as { created_at: string; details: { key?: string } | null }[]

    const duplicate = rows.some(
      (r) => r.details?.key === key && now - new Date(r.created_at).getTime() < DEDUPE_WINDOW_MS
    )
    if (duplicate) return

    await logAudit(db, {
      event_type: report.kind,
      actor: 'system',
      message: report.message,
      details: { source: report.source, key, ...(errorText ? { error: errorText } : {}), ...report.details },
    })

    if (db === productionDb && rows.length === 0) {
      await sendAlertText(`${report.message}${errorText ? ` (${errorText})` : ''}`)
    }
  } catch (err) {
    console.error('failure report failed:', err, report)
  }
}

// For route handlers: report the failure and return the JSON error response.
// `publicMessage` is what the caller sees. Reports to the request's own
// environment, so a test-mode failure stays in the sandbox trail.
export async function serverError(
  source: string,
  err: unknown,
  publicMessage = 'Server error',
  status = 500
): Promise<NextResponse> {
  console.error(`${source} error`, err)
  const db = await getDb().catch(() => productionDb)
  await reportFailure(db, {
    // A cron route failing means a scheduled job didn't do its work.
    kind: source.startsWith('api/cron/') ? 'job-failed' : 'server-error',
    source,
    message: `${source} returned ${status}: ${publicMessage}`,
    error: err,
  })
  return NextResponse.json({ error: publicMessage }, { status })
}

export type AlertSendResult = { sent: true } | { sent: false; reason: string }

// Plain text, short subject: the gateway shows "subject / body" as one SMS.
export async function sendAlertText(body: string): Promise<AlertSendResult> {
  const to = process.env.ALERT_SMS_TO
  if (!to) return { sent: false, reason: 'ALERT_SMS_TO is not set' }
  if (process.env.EMAILS_ENABLED !== 'true') return { sent: false, reason: 'Email is off (EMAILS_ENABLED is not "true")' }

  const text = body.length > SMS_MAX_CHARS ? `${body.slice(0, SMS_MAX_CHARS - 1)}…` : body
  try {
    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      subject: 'Madness',
      text,
    })
    if (error) {
      console.error('alert text failed:', error)
      return { sent: false, reason: error.message }
    }
    return { sent: true }
  } catch (err) {
    console.error('alert text failed:', err)
    return { sent: false, reason: describeError(err) }
  }
}
