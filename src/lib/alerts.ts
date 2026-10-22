import 'server-only'
import {randomUUID} from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit } from './audit'
import { recordEmail,FROM_EMAIL } from './delivery'
import { supabase as productionDb } from './supabase'
import { getDb } from './testMode'
import type { FailureEventType } from './auditEvents'
import { redactLog } from './logRedaction'

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
 return redactLog(err)
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
    console.error('failure report failed:', describeError(err), report.source)
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
  const correlationId=randomUUID()
  console.error(`${source} error`,correlationId,describeError(err))
  const db = await getDb().catch(() => productionDb)
  await db.rpc('record_incident',{p_key:source,p_impact:publicMessage,p_correlation:correlationId,p_detail:describeError(err).slice(0,1000)}).then(()=>{},()=>{})
  await reportFailure(db, {
    // A cron route failing means a scheduled job didn't do its work.
    kind: source.startsWith('api/cron/') ? 'job-failed' : 'server-error',
    source,
    message: `${source} returned ${status}: ${publicMessage}`,
    error: err,
  })
  return NextResponse.json({ error: publicMessage,correlationId }, { status,headers:{'X-Correlation-ID':correlationId} })
}

export type AlertSendResult = { sent: true } | { sent: false; reason: string }

// Plain text, short subject: the gateway shows "subject / body" as one SMS.
export async function sendAlertText(body: string,db:SupabaseClient=productionDb): Promise<AlertSendResult> {
 const to=process.env.ALERT_SMS_TO
 if(!to)return {sent:false,reason:'ALERT_SMS_TO is not configured'}
 const text=body.length>SMS_MAX_CHARS?`${body.slice(0,SMS_MAX_CHARS-1)}…`:body
 try{
  for(const recipient of to.split(',').map(s=>s.trim()).filter(Boolean))await recordEmail(db,{from:FROM_EMAIL,to:recipient,subject:'Madness',text},'operational')
  return {sent:false,reason:'Notification recorded; delivery follows configured email mode'}
 }catch{return {sent:false,reason:'Could not record operational notification'}}
}
