import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { adminSessionId } from './session'
import type { AuditEntry } from './auditEvents'

export type { AuditActor, AuditEntry, AuditEventType, AuditRow } from './auditEvents'
export { AUDIT_EVENT_TYPES } from './auditEvents'

// Best-effort write: the audit trail must never break or slow down the action
// it records, so failures are logged to the console and swallowed. Callers
// pass their own db client (getDb()'s result) so test-mode writes land in the
// sandbox's log, not production's.
export async function logAudit(db: SupabaseClient, entry: AuditEntry): Promise<void> {
  try {
    const recorded = entry.actor === 'admin' ? { ...entry, details: { ...entry.details, admin_session: await adminSessionId() } } : entry
    const { error } = await db.from('audit_log').insert(recorded)
    if (error) console.error('audit log write failed:', error.message, entry)
  } catch (err) {
    console.error('audit log write failed:', err, entry)
  }
}
