import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit } from './audit'
import { recoveryKeysForWorkload, describeIncident, WORKLOADS, type JobStatus } from './incidentText'

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

// Open incidents that belong to a job which has succeeded since they last happened.
export async function recoveredIncidentKeys(db: SupabaseClient): Promise<string[]> {
  const [incidents, runs] = await Promise.all([
    db.from('incidents').select('key, occurrences, latest_at').eq('status', 'open'),
    db.from('operation_runs').select('key, last_success_at'),
  ])
  if (incidents.error) throw incidents.error
  if (runs.error) throw runs.error
  const jobs: JobStatus[] = WORKLOADS.map((w) => ({ id: w.id, lastSuccessAt: (runs.data ?? []).find((r: { key: string }) => r.key === `recurring:${w.id}`)?.last_success_at ?? null }))
  return (incidents.data ?? []).filter((i: { key: string; occurrences: number; latest_at: string }) => describeIncident(i, jobs).recovered).map((i: { key: string }) => i.key)
}
