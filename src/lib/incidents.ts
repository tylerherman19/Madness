import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit } from './audit'
import { recoveryKeysForWorkload } from './incidentText'

// Incidents live in one table (migration 025); "resolved" is a status the table already allows and
// record_incident reopens it if the same problem happens again. Service-role updates are enough, so
// no migration is needed.

async function close(db: SupabaseClient, keys: string[]): Promise<string[]> {
  if (!keys.length) return []
  const { data, error } = await db.from('incidents').update({ status: 'resolved' }).in('key', keys).eq('status', 'open').select('key')
  if (error) throw error
  return (data ?? []).map((row: { key: string }) => row.key)
}

export async function resolveByPrefix(db: SupabaseClient, prefix: string, note: string): Promise<number> {
  const { data, error } = await db.from('incidents').select('key').eq('status', 'open')
  if (error) throw error
  const keys = (data ?? []).map((row: { key: string }) => row.key).filter((key: string) => key.startsWith(prefix))
  const closed = await close(db, keys)
  if (closed.length) await logAudit(db, { event_type: 'incident-resolved', actor: 'system', message: `Resolved ${closed.length} incident${closed.length === 1 ? '' : 's'}`, details: { keys: closed, note } })
  return closed.length
}

// A job that just finished successfully has recovered from any "delayed" or "server error" incident
// recorded for it. Never touches incidents that need a human decision. Best effort: it must not
// make a successful job report failure.
export async function resolveRecoveredForWorkload(db: SupabaseClient, workload: string): Promise<void> {
  try {
    const closed = await close(db, recoveryKeysForWorkload(workload))
    if (closed.length) await logAudit(db, { event_type: 'incident-resolved', actor: 'system', message: 'Recovered: the job has run successfully since', details: { keys: closed, note: 'Recovered: the job has run successfully since' } })
  } catch (error) {
    console.error('could not resolve recovered incidents', error)
  }
}

export async function resolveIncident(db: SupabaseClient, key: string, note: string): Promise<boolean> {
  const closed = await close(db, [key])
  if (closed.length) await logAudit(db, { event_type: 'incident-resolved', actor: 'admin', message: `Marked an incident as resolved`, details: { keys: closed, note } })
  return closed.length > 0
}

export async function resolveMany(db: SupabaseClient, keys: string[], note: string): Promise<number> {
  const closed = await close(db, keys)
  if (closed.length) await logAudit(db, { event_type: 'incident-resolved', actor: 'admin', message: `Cleared ${closed.length} recovered problem${closed.length === 1 ? '' : 's'}`, details: { keys: closed, note } })
  return closed.length
}

export async function resolveRecoveredKey(db: SupabaseClient, key: string): Promise<void> {
  try {
    const closed = await close(db, [key])
    if (closed.length) await logAudit(db, { event_type: 'incident-resolved', actor: 'system', message: 'Recovered: the job has run successfully since', details: { keys: closed, note: 'Recovered: the job has run successfully since' } })
  } catch (error) { console.error('could not resolve recovered incident', error) }
}
