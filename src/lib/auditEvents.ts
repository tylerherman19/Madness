// Shared audit types + labels. Kept out of `audit.ts` (which is server-only)
// so the admin audit page's client component can import the labels.

export type AuditActor = 'admin' | 'system' | 'player'

// Canonical event types — the audit page's filter dropdown is built from this
// list, so new events must be registered here.
export const AUDIT_EVENT_TYPES: Record<string, string> = {
  'pick-submitted': 'Pick submitted',
  'pick-changed': 'Pick changed',
  'pick-auto-assigned': 'Pick auto-assigned',
  'player-eliminated': 'Player eliminated',
  'player-updated': 'Player updated',
  'player-deleted': 'Player deleted',
  'password-reset-requested': 'Password reset requested',
  'password-reset': 'Password reset',
  'password-reset-link-created': 'Password reset link created',
  'password-reset-link-expired': 'Expired reset link tried',
  'password-reset-link-reused': 'Used reset link tried again',
  'players-imported': 'Players imported',
  'result-set': 'Result set',
  'result-released': 'Result released to ESPN',
  'game-voided': 'Game voided',
  'void-undone': 'Void undone',
  'slate-graded': 'Slate graded',
  'results-synced': 'Results synced',
  'schedule-synced': 'Schedule synced',
  'slate-activated': 'Slate activated',
  'slate-advanced': 'Slate advanced',
  'slate-advance-requested': 'Advance requested',
  'broadcast-sent': 'Broadcast sent',
  'pool-reset': 'Pool reset',
  'pool-config-updated': 'Pool configuration updated',
  'welcome-email-failed': 'Welcome email failed',
  'player-signed-up': 'Player signed up',
  'job-failed': 'Job failed',
  'server-error': 'Server error',
  'email-failed': 'Email failed',
  'daily-summary': 'Daily summary',
  'operation-retried': 'Operation retried',
  'retention-applied': 'Retention applied',
}

// Failure events: reported through lib/alerts.ts, highlighted on the audit
// page and counted by the daily summary.
export const FAILURE_EVENTS = new Set(['job-failed', 'server-error', 'email-failed', 'welcome-email-failed'])
export type FailureEventType = 'job-failed' | 'server-error' | 'email-failed'

export type AuditEventType = keyof typeof AUDIT_EVENT_TYPES

export interface AuditEntry {
  event_type: AuditEventType
  actor: AuditActor
  message: string
  player_id?: string | null
  player_name?: string | null
  details?: Record<string, unknown> | null
}

export interface AuditRow extends AuditEntry {
  id: string
  created_at: string
}
