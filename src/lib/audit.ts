import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditEntry } from './auditEvents'
import { supabase } from './supabase'

export type { AuditActor, AuditEntry, AuditEventType, AuditRow } from './auditEvents'
export { AUDIT_EVENT_TYPES } from './auditEvents'

// Best-effort write: the audit trail must never break or slow down the action
// it records, so failures are logged to the console and swallowed. Callers
// pass their own db client (getDb()'s result) so test-mode writes land in the
// sandbox's log, not production's.
export async function logAudit(db: SupabaseClient, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await db.from('audit_log').insert(entry)
    if (error) console.error('audit log write failed:', error.message, entry)
  } catch (err) {
    console.error('audit log write failed:', err, entry)
  }
}

// Scheduled jobs run with nobody watching, so a failure must land somewhere an
// organizer will see it: the runtime log for developers, and the audit log
// (filter "Scheduled job failed") for the admin. Always recorded in production
// — a cron run has no test-mode cookie. Never throws.
export async function reportJobFailure(
  job: string,
  err: unknown,
  details: Record<string, unknown> = {},
  db: SupabaseClient = supabase
): Promise<void> {
  const reason = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
  console.error(`[job:${job}] failed`, err)
  await logAudit(db, {
    event_type: 'job-failed',
    actor: 'system',
    message: `${job} failed: ${reason.slice(0, 300)}`,
    details: { job, ...details },
  })
}
