import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getResultsAttention } from '@/lib/attention'
import { getContestState } from '@/lib/contestState'
import { sessionSecretStatus } from '@/lib/sessionSecret'
import { evaluateHealth, type HealthStatus, type IncidentRow, type JobRun } from '@/lib/opsHealth'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Operations', description: 'Pick and Pray administration: scheduled job health.' }

const stamp = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' }) : 'Never'
const LABEL: Record<HealthStatus, string> = { ok: 'OK', overdue: 'Overdue', failing: 'Failing', off: 'Off' }
const PILL_STYLE: Record<HealthStatus, string> = {
  ok: 'pill pill-alive',
  failing: 'pill pill-out',
  overdue: 'pill',
  off: 'pill',
}
const STYLE: Record<HealthStatus, React.CSSProperties | undefined> = {
  ok: undefined, failing: undefined, off: undefined,
  overdue: { background: 'var(--warning-tint)', color: 'var(--warning)' },
}

export default async function Operations() {
  if (!(await getAdminSession())) redirect('/admin/login')
  const db = await getDb()
  const now = await getEffectiveNow()
  const [jobsResult, incidentsResult, slateResult, requirement, counts, attention, contest] = await Promise.all([
    // The same read the health endpoint uses to prove the database answers.
    db.from('operation_runs').select('key,status,last_success_at,updated_at,last_error').order('updated_at', { ascending: false }).limit(200),
    db.from('incidents').select('key,impact,status,occurrences,latest_at').eq('status', 'open').order('latest_at', { ascending: false }).limit(100),
    db.from('slates').select('slate_date,locks_at,auto_assign_completed_at').eq('is_active', true).maybeSingle(),
    db.rpc('active_pick_requirement'),
    db.rpc('contest_counts'),
    getResultsAttention(db),
    getContestState(),
  ])
  const slate = slateResult.data
    ? {
        slate_date: slateResult.data.slate_date as string,
        deadline: ((requirement.data as { deadline?: string | null } | null)?.deadline ?? slateResult.data.locks_at ?? null) as string | null,
        auto_assign_completed_at: (slateResult.data.auto_assign_completed_at ?? null) as string | null,
      }
    : null
  const unpicked = (counts.data as { unpicked?: number } | null)?.unpicked
  const health = evaluateHealth({
    now,
    automationEnabled: process.env.AUTOMATION_V2_ENABLED === 'true',
    perWorkload: process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true',
    jobs: (jobsResult.data ?? []) as JobRun[],
    incidents: (incidentsResult.data ?? []) as IncidentRow[],
    slate,
    unpicked: typeof unpicked === 'number' ? unpicked : null,
    attentionCount: attention.count,
    contest: contest ? { stopped: contest.stopped, alive: contest.alive } : null,
    databaseOk: !jobsResult.error,
    sessionSecret: sessionSecretStatus(),
  })

  return (
    <section className="system-page">
      <h1>Operations</h1>
      <p>
        Overall: <span className={PILL_STYLE[health.overall]} style={STYLE[health.overall]}>{LABEL[health.overall]}</span> · Observed {stamp(now.toISOString())}. All times are Central.
      </p>
      {health.weakSecret && (
        <p role="alert">Warning: the session secret is weak. Replace SESSION_SECRET with a long random value.</p>
      )}
      {health.stopped && <p role="status">Stopped: no entries alive.</p>}
      <div className="system-table">
        <table aria-label="Scheduled job health">
          <thead>
            <tr><th>Job</th><th>Status</th><th>Last success</th><th>Details</th><th>Last error</th></tr>
          </thead>
          <tbody>
            {health.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.label}</td>
                <td><span className={PILL_STYLE[line.status]} style={STYLE[line.status]}>{LABEL[line.status]}</span></td>
                <td>{line.id === 'database' || line.id === 'contest' ? '' : stamp(line.lastSuccessAt)}</td>
                <td>
                  {line.detail}
                  {line.id === 'contest' && attention.count > 0 && <> <Link href="/admin/results">Open Results</Link></>}
                </td>
                <td>{line.lastError ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Open incidents</h2>
      {incidentsResult.error ? (
        <p>Incident monitoring unavailable.</p>
      ) : !health.incidents.length ? (
        <p>No open incidents.</p>
      ) : (
        <div className="system-table">
          <table aria-label="Open incidents">
            <thead><tr><th>Incident</th><th>Occurrences</th><th>Last seen</th></tr></thead>
            <tbody>
              {health.incidents.map((i) => (
                <tr key={i.key}><td>{i.impact} <small>({i.key})</small></td><td>{i.occurrences}</td><td>{stamp(i.latestAt)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        More detail: <Link href="/admin/system">System overview</Link> · <Link href="/admin/system/jobs">Background jobs</Link> · <Link href="/admin/system/incidents">Errors and incidents</Link>
      </p>
    </section>
  )
}
