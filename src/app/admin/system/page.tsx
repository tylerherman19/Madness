import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getResultsAttention } from '@/lib/attention'
import { getContestState } from '@/lib/contestState'
import { sessionSecretStatus } from '@/lib/sessionSecret'
import { evaluateHealth, evaluateJob, type HealthStatus, type IncidentRow, type JobRun } from '@/lib/opsHealth'
import { WORKLOADS, incidentSentence, summarize, type IncidentCard } from '@/lib/incidentText'
import { staleDay, longDate, shortDate, centralStamp, relativeTime } from '@/lib/staleDay'
import StaleDayBanner from '../StaleDayBanner'
import { ResolveIncident, ClearRecovered } from './StatusActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'System status', description: 'Pick and Pray administration: is everything running.' }

// How long each automatic job may go without a success before it is called late (minutes).
const LATE_AFTER: Record<string, number> = { results: 15, grading: 15, assignment: 15, advance: 30, schedule: 60, reminders: 15, integrity: 30, retention: 1560 }
const ROW_ORDER = ['results', 'grading', 'assignment', 'advance', 'schedule', 'reminders', 'integrity', 'retention']
const WORD: Record<HealthStatus, string> = { ok: 'OK', overdue: 'Late', failing: 'Failing', off: 'Off' }
const PILL: Record<HealthStatus, string> = { ok: 'pill pill-alive', failing: 'pill pill-out', overdue: 'pill', off: 'pill' }
const PILL_STYLE: Record<HealthStatus, React.CSSProperties | undefined> = {
  ok: undefined, failing: undefined, off: undefined, overdue: { background: 'var(--warning-tint)', color: 'var(--warning)' },
}
const NOTE: Record<HealthStatus, string> = {
  ok: '', off: 'Automatic jobs are switched off.', failing: 'The last attempt did not work. It tries again by itself.', overdue: 'It has not finished recently.',
}

export default async function SystemStatus() {
  if (!(await getAdminSession())) redirect('/admin/login')
  const db = await getDb()
  const now = await getEffectiveNow()
  const [jobsResult, incidentsResult, slateResult, requirement, counts, attention, contest] = await Promise.all([
    db.from('operation_runs').select('key,status,last_success_at,updated_at,last_error').order('updated_at', { ascending: false }).limit(200),
    db.from('incidents').select('key,impact,status,occurrences,first_at,latest_at').eq('status', 'open').order('latest_at', { ascending: false }).limit(200),
    db.from('slates').select('slate_number,slate_date,locks_at,auto_assign_completed_at').eq('is_active', true).maybeSingle(),
    db.rpc('active_pick_requirement'),
    db.rpc('contest_counts'),
    getResultsAttention(db),
    getContestState(),
  ])
  const perWorkload = process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true'
  const automationEnabled = process.env.AUTOMATION_V2_ENABLED === 'true'
  const slate = slateResult.data
  const deadline = ((requirement.data as { deadline?: string | null } | null)?.deadline ?? slate?.locks_at ?? null) as string | null
  const count = (counts.data ?? {}) as { alive?: number; unpicked?: number }
  const unpicked = typeof count.unpicked === 'number' ? count.unpicked : null
  const jobs = (jobsResult.data ?? []) as JobRun[]
  const incidentRows = (incidentsResult.data ?? []) as IncidentRow[]
  const health = evaluateHealth({
    now, automationEnabled, perWorkload, jobs, incidents: incidentRows,
    slate: slate ? { slate_date: slate.slate_date as string, deadline, auto_assign_completed_at: (slate.auto_assign_completed_at ?? null) as string | null } : null,
    unpicked, attentionCount: attention.count,
    contest: contest ? { stopped: contest.stopped, alive: contest.alive } : null,
    databaseOk: !jobsResult.error, sessionSecret: sessionSecretStatus(),
  })

  // One row per job. Per-job records exist once the reliability schema is active; otherwise one overall row.
  const byKey = new Map(jobs.map((j) => [j.key, j]))
  const rows = perWorkload
    ? ROW_ORDER.map((id) => {
        const workload = WORKLOADS.find((w) => w.id === id)!
        const line = evaluateJob(id, workload.label, byKey.get(`recurring:${id}`), LATE_AFTER[id], now, automationEnabled)
        return { id, label: workload.label, status: line.status, lastSuccessAt: line.lastSuccessAt }
      })
    : (() => { const line = health.lines.find((l) => l.id === 'heartbeat')!; return [{ id: 'heartbeat', label: 'Background work', status: line.status, lastSuccessAt: line.lastSuccessAt }] })()
  const jobStatus = rows.map((r) => ({ id: r.id, lastSuccessAt: r.lastSuccessAt }))

  const day = staleDay(slate?.slate_date as string | undefined, now)
  const extra: IncidentCard[] = []
  if (jobsResult.error) extra.push({ key: 'database', title: 'The site cannot read its records', meaning: 'Pages that need saved information may fail to load.', todo: 'Wait a minute and refresh. If it stays like this, contact whoever hosts the site.', occurrences: 1, latestAt: now.toISOString(), recovered: false })
  if (attention.count > 0) extra.push({ key: 'results', title: `${attention.count} result${attention.count === 1 ? '' : 's'} need${attention.count === 1 ? 's' : ''} your attention`, meaning: 'A game is stalled or an entry is waiting for you to restore it, so some picks are not graded yet.', todo: 'Open Results and finish those items.', fix: { href: '/admin/results', label: 'Open Results' }, occurrences: 1, latestAt: now.toISOString(), recovered: false })

  const summary = summarize(
    incidentRows, jobStatus, rows.map((r) => ({ id: r.id, state: r.status })), day.stale, extra.length,
  )
  const emailOn = process.env.EMAILS_ENABLED === 'true' && process.env.OUTBOX_DELIVERY_ENABLED === 'true'
  const assignment = health.assignment.state

  return (
    <section className="system-page" aria-labelledby="status-title">
      <h1 id="status-title">System status</h1>
      <p role="status" style={{ fontSize: 22, fontWeight: 600 }}>{summary.headline}</p>
      <p>Checked {centralStamp(now)}. All times are Central.</p>
      {health.weakSecret && <p role="alert">Notice: the key that protects logins is weak. It still works, but ask whoever manages the hosting to replace it with a long random value.</p>}

      <h2>Needs your attention</h2>
      {day.stale && day.activeDate && <StaleDayBanner level={3} activeDate={day.activeDate} expectedDate={day.expectedDate} daysBehind={day.daysBehind} />}
      {summary.open.length === 0 && extra.length === 0 && !day.stale && !summary.failingJobs && !summary.lateJobs && <p>Nothing needs you right now.</p>}
      {extra.map((card) => <IncidentArticle key={card.key} card={card} now={now} resolvable={false} />)}
      {summary.open.map((card) => <IncidentArticle key={card.key} card={card} now={now} resolvable />)}
      {incidentsResult.error && <p role="alert">Problem reports could not be loaded.</p>}
      {summary.recovered.length > 0 && (
        <details>
          <summary>Recovered by itself ({summary.recovered.length})</summary>
          <p>These problems happened earlier but the job has run normally since. They are not counted above.</p>
          <ul>
            {summary.recovered.map((card) => <li key={card.key}>{incidentSentence(card, shortDate(card.latestAt.slice(0, 10)))}</li>)}
          </ul>
          <ClearRecovered count={summary.recovered.length} />
        </details>
      )}

      <h2>Automatic jobs</h2>
      <p>These run by themselves in the background. You do not need to do anything unless one says Late or Failing.</p>
      <div className="system-table">
        <table aria-label="Automatic jobs" style={{ minWidth: 0 }}>
          <caption className="sr-only">Automatic jobs, when each last ran and whether it is on time</caption>
          <thead><tr><th scope="col">Job</th><th scope="col">Last ran</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" style={{ fontWeight: 500 }}>{row.label}</th>
                <td>{row.status === 'off' ? '—' : relativeTime(row.lastSuccessAt, now)}</td>
                <td>
                  <span className={PILL[row.status]} style={PILL_STYLE[row.status]}>{WORD[row.status]}</span>
                  {NOTE[row.status] && <small style={{ display: 'block' }}>{NOTE[row.status]}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Email: {emailOn ? 'switched on.' : 'switched off. No email is being sent.'} <Link href="/admin/system/email">Email details</Link></p>

      <h2>Today</h2>
      {!slate ? <p>There is no active day. Choose one on the Schedule page.</p> : (
        <dl className="system-summary">
          <dt>Active day</dt>
          <dd>{longDate(slate.slate_date as string)}{day.stale ? ` (${day.daysBehind} day${day.daysBehind === 1 ? '' : 's'} behind; see the button above)` : ''}</dd>
          <dt>Pick deadline</dt>
          <dd>{deadline ? centralStamp(deadline) : 'Not set'}</dd>
          <dt>Entries alive</dt>
          <dd>{typeof count.alive === 'number' ? count.alive : 'Unknown'}{contest?.stopped ? ' (everyone is out)' : ''}</dd>
          <dt>Picks in</dt>
          <dd>{typeof count.alive === 'number' && unpicked !== null ? `${Math.max(0, count.alive - unpicked)} of ${count.alive}` : 'Unknown'}</dd>
          <dt>Missed picks assigned</dt>
          <dd>{assignment === 'complete' ? 'Done' : assignment === 'unlocked' ? 'Not needed yet. The deadline has not passed.' : assignment === 'incomplete' ? 'Not finished yet' : 'No active day'}</dd>
        </dl>
      )}
      <p>
        More: <Link href="/admin/audit">Activity log</Link> · <Link href="/admin/system/advanced">Advanced details</Link> (optional, technical)
      </p>
    </section>
  )
}

function IncidentArticle({ card, now, resolvable }: { card: IncidentCard; now: Date; resolvable: boolean }) {
  const when = card.occurrences > 1 || card.jobName ? `Last happened ${centralStamp(card.latestAt)} (${relativeTime(card.latestAt, now)}), ${card.occurrences} time${card.occurrences === 1 ? '' : 's'}.` : ''
  return (
    <article aria-label={card.title}>
      <h3 style={{ fontWeight: 600 }}>{card.title}</h3>
      <p>{card.meaning}</p>
      <p><strong>What to do:</strong> {card.todo}</p>
      {when && <p>{when}</p>}
      {card.fix && <p><Link href={card.fix.href}>{card.fix.label}</Link></p>}
      {resolvable && <ResolveIncident incidentKey={card.key} title={card.title} />}
    </article>
  )
}
