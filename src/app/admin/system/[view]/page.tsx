import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import Actions from '../Actions'
import Controls from '../../operations/Controls'
const views: Record<string, string> = {
  overview: 'System overview',
  email: 'Email operations',
  jobs: 'Background jobs',
  incidents: 'Errors and incidents',
  integrity: 'Data integrity',
  recovery: 'Recovery',
}
const stamp = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        timeZoneName: 'short',
      })
    : 'Not observed'
export default async function SystemView({
  params,
  searchParams,
}: {
  params: Promise<{ view: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  if (!(await getAdminSession())) redirect('/admin/login')
  const { view } = await params
  if (!views[view]) notFound()
  const query = await searchParams,
    page = Math.max(0, Number(query.page) || 0),
    db = await getDb()
  const ready =
    process.env.EMAILS_ENABLED === 'true' &&
    process.env.OUTBOX_DELIVERY_ENABLED === 'true' &&
    !!process.env.RESEND_API_KEY
  const [settings, jobs, check] = await Promise.all([
    db
      .from('delivery_settings')
      .select('mode,changed_by,changed_at,reason,paused_until,pause_reason')
      .eq('id', true)
      .maybeSingle(),
    db
      .from('operation_runs')
      .select(
        'key,status,attempts,next_attempt_at,lease_until,last_success_at,updated_at,last_error,progress,correlation_id',
      )
      .order('updated_at', { ascending: false })
      .range(page * 50, page * 50 + 49),
    db
      .from('integrity_checks')
      .select('observed_at,findings')
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const unavailable = settings.error || jobs.error || check.error
  const heading = (
    <>
      <h1>{views[view]}</h1>
      <p>Observed {stamp(new Date().toISOString())}. All times are Central.</p>
    </>
  )
  if (unavailable)
    return (
      <section className="system-page">
        {heading}
        <p role="alert">
          Monitoring unavailable. Verify migrations 025–026 and database access.
          Missing telemetry cannot establish health.
        </p>
      </section>
    )
  const pagination = (
    <nav aria-label="Record pages">
      {page > 0 && (
        <Link
          href={`?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as Record<string, string>), page: String(page - 1) })}`}
        >
          Previous
        </Link>
      )}{' '}
      <span>Page {page + 1}</span>{' '}
      <Link
        href={`?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as Record<string, string>), page: String(page + 1) })}`}
      >
        Next
      </Link>
    </nav>
  )
  let content
  if (view === 'overview') {
    const worker = jobs.data?.find(
      (j) => j.key.startsWith('worker:') || j.key === 'recurring:results',
    )
    const stale =
      !worker?.last_success_at ||
      new Date().getTime() - new Date(worker.last_success_at).getTime() > 600000
    const { count: openIncidents, error: incError } = await db
      .from('incidents')
      .select('key', { count: 'exact', head: true })
      .eq('status', 'open')
    const { count: backlog, error: backlogError } = await db
      .from('notification_outbox')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'processing'])
    const { data: oldest } = await db
      .from('notification_outbox')
      .select('created_at')
      .eq('status', 'pending')
      .order('created_at')
      .limit(1)
      .maybeSingle()
    content = (
      <>
        <dl className="system-summary">
          <dt>Database</dt>
          <dd>Reachable for this observation</dd>
          <dt>Background processing</dt>
          <dd>
            {process.env.AUTOMATION_V2_ENABLED !== 'true'
              ? 'Disabled'
              : stale
                ? 'Delayed or unknown'
                : 'Recently observed'}{' '}
            · last successful results/worker pass{' '}
            {stamp(worker?.last_success_at)}
          </dd>
          <dt>Email</dt>
          <dd>
            {settings.data?.mode ?? 'Unknown'} · provider{' '}
            {ready
              ? 'configured, sender and quota still require verification'
              : 'not ready; master switch or provider configuration missing'}
          </dd>
          <dt>Eligible processing backlog</dt>
          <dd>
            {backlogError ? 'Unknown' : backlog} · oldest pending{' '}
            {stamp(oldest?.created_at)}
          </dd>
          <dt>Open incidents</dt>
          <dd>{incError ? 'Unknown' : openIncidents}</dd>
          <dt>Latest integrity observation</dt>
          <dd>{stamp(check.data?.observed_at)}</dd>
          <dt>Deployment</dt>
          <dd>
            {process.env.VERCEL_ENV ?? 'Local'} ·{' '}
            {process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
              'Version unavailable'}
          </dd>
          <dt>Backup / verified restore</dt>
          <dd>Unknown in this view. Verify workflow artifacts in Recovery.</dd>
        </dl>
        <p>
          A recent heartbeat does not prove all assignments, grading or
          deliveries finished. Open the workload and integrity records below.
        </p>
        <div className="system-links">
          {Object.entries(views)
            .filter(([key]) => key !== 'overview')
            .map(([key, title]) => (
              <Link key={key} href={`/admin/system/${key}`}>
                {title}
              </Link>
            ))}
        </div>
      </>
    )
  } else if (view === 'jobs')
    content = (
      <>
        <p>
          Each workload has its own lease and retry time. One failed workload
          does not prevent the scheduler from dispatching others.
        </p>
        <div className="system-table">
          <table>
            <thead>
              <tr>
                <th>Workload / scope</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Lease / next attempt</th>
                <th>Last successful completion</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data?.map((job) => (
                <tr key={job.key}>
                  <td>{job.key}</td>
                  <td>{job.status}</td>
                  <td>{job.attempts}</td>
                  <td>
                    {stamp(job.lease_until)} / {stamp(job.next_attempt_at)}
                  </td>
                  <td>{stamp(job.last_success_at)}</td>
                  <td>
                    <details>
                      <summary>Progress and diagnostics</summary>
                      <pre>{JSON.stringify(job.progress, null, 2)}</pre>
                      <p>{job.last_error}</p>
                      <p>Correlation {job.correlation_id}</p>
                    </details>
                    {job.status === 'review' && (
                      <Controls action="retry-job" id={job.key} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!jobs.data?.length && <p>Nothing recorded yet.</p>}
        {pagination}
      </>
    )
  else if (view === 'email') {
    let messages = db
      .from('notification_outbox')
      .select(
        'id,kind,recipient,player_id,campaign_id,status,delivery_outcome,created_at,expires_at,attempts,provider_id,last_error,accepted_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .order('id')
      .range(page * 50, page * 50 + 49)
    if (query.campaign) messages = messages.eq('campaign_id', query.campaign)
    if (query.recipient)
      messages = messages.ilike(
        'recipient',
        `%${query.recipient.replace(/[%_]/g, '')}%`,
      )
    if (query.status) messages = messages.eq('status', query.status)
    if (query.kind) messages = messages.eq('kind', query.kind)
    if (query.player) messages = messages.eq('player_id', query.player)
    if (query.from) messages = messages.gte('created_at', query.from)
    const [result, campaigns] = await Promise.all([
      messages,
      db
        .from('email_campaigns')
        .select('id,subject,status,created_at,cursor_id')
        .order('created_at', { ascending: false })
        .range(page * 20, page * 20 + 19),
    ])
    const detail = query.id
      ? await db
          .from('notification_outbox')
          .select('id,kind,payload,provider_id')
          .eq('id', query.id)
          .maybeSingle()
      : null
    const attempts = query.id
      ? await db
          .from('notification_attempts')
          .select('id,started_at,finished_at,outcome,error_code,correlation_id')
          .eq('notification_id', query.id)
          .order('started_at')
          .limit(100)
      : null
    const events = detail?.data?.provider_id
      ? await db
          .from('provider_events')
          .select('id,kind,occurred_at,received_at')
          .eq('provider_id', detail.data.provider_id)
          .order('received_at')
          .limit(100)
      : null
    content = (
      <>
        <p>
          Mode: <strong>{settings.data?.mode}</strong>. Changed by{' '}
          {settings.data?.changed_by}, {stamp(settings.data?.changed_at)}.{' '}
          {settings.data?.reason}
        </p>
        <p>
          Master switch {process.env.EMAILS_ENABLED === 'true' ? 'on' : 'off'};
          outbox switch{' '}
          {process.env.OUTBOX_DELIVERY_ENABLED === 'true' ? 'on' : 'off'};
          provider key {process.env.RESEND_API_KEY ? 'present' : 'missing'}.
          Live approval{' '}
          {process.env.LIVE_EMAIL_ACTIVATION_APPROVED === 'true'
            ? 'configured'
            : 'pending separate authorization'}
          .
        </p>
        <p>
          Provider accepted means Resend accepted the request. Delivered
          requires a verified callback. Neither proves reading. Held records are
          never released automatically when modes change.
        </p>
        {settings.data?.paused_until && (
          <p>
            Provider paused until {stamp(settings.data.paused_until)}:{' '}
            {settings.data.pause_reason}
          </p>
        )}
        <details>
          <summary>Delivery mode controls</summary>
          <Actions action="mode" />
        </details>
        <h2>Campaigns</h2>
        {campaigns.error ? (
          <p>Campaign data unavailable.</p>
        ) : campaigns.data?.length ? (
          campaigns.data.map((c) => (
            <article key={c.id}>
              <Link href={`?campaign=${c.id}`}>{c.subject}</Link> · {c.status} ·{' '}
              {stamp(c.created_at)}
              <details>
                <summary>Cancel</summary>
                <Actions action="cancel-campaign" id={c.id} />
              </details>
            </article>
          ))
        ) : (
          <p>No campaigns recorded.</p>
        )}
        <h2>Messages</h2>
        <form>
          <label>
            Recipient <input name="recipient" defaultValue={query.recipient} />
          </label>
          <details>
            <summary>More filters</summary>
            <label>
              Campaign <input name="campaign" defaultValue={query.campaign} />
            </label>
            <label>
              Entry ID <input name="player" defaultValue={query.player} />
            </label>
            <label>
              Type <input name="kind" defaultValue={query.kind} />
            </label>
            <label>
              Status{' '}
              <select name="status" defaultValue={query.status ?? ''}>
                {[
                  '',
                  'held',
                  'pending',
                  'processing',
                  'sent',
                  'review',
                  'suppressed',
                  'expired',
                  'canceled',
                ].map((s) => (
                  <option key={s} value={s}>
                    {s || 'All states'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Since <input type="date" name="from" defaultValue={query.from} />
            </label>
          </details>
          <button>Search</button>
        </form>
        <p>
          {result.error
            ? 'Messages unavailable'
            : `${result.count} matching records`}
          . Drain time is unmeasured until a provider-connected staging run.
        </p>
        {result.data?.length ? (
          <div className="system-table">
            <table>
              <thead>
                <tr>
                  <th>Recipient / type</th>
                  <th>Processing</th>
                  <th>Provider outcome</th>
                  <th>Attempts</th>
                  <th>Created / expires</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`?id=${m.id}`}>
                        {m.recipient ?? 'Unavailable'}
                      </Link>
                      <br />
                      {m.kind}
                      {m.player_id && (
                        <>
                          <br />
                          <Link href={`/admin/players/${m.player_id}`}>
                            Entry history
                          </Link>
                        </>
                      )}
                    </td>
                    <td>
                      {m.status === 'sent' ? 'Provider accepted' : m.status}
                    </td>
                    <td>{m.delivery_outcome ?? 'Not observed'}</td>
                    <td>{m.attempts}</td>
                    <td>
                      {stamp(m.created_at)}
                      <br />
                      {stamp(m.expires_at)}
                    </td>
                    <td>
                      {m.last_error}
                      {m.status === 'review' && (
                        <details>
                          <summary>Review retry</summary>
                          <Actions action="retry-message" id={m.id} />
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No messages match.</p>
        )}
        {pagination}
        {detail?.data && (
          <section>
            <h2>Message history</h2>
            {detail.data.kind === 'password-reset' ? (
              <p>Restricted account message. Content and tokens are hidden.</p>
            ) : (
              <pre>{JSON.stringify(detail.data.payload, null, 2)}</pre>
            )}
            <h3>Attempts</h3>
            <pre>{JSON.stringify(attempts?.data ?? [], null, 2)}</pre>
            <h3>Verified provider events</h3>
            <pre>{JSON.stringify(events?.data ?? [], null, 2)}</pre>
          </section>
        )}
      </>
    )
  } else if (view === 'incidents') {
    const { data, error } = await db
      .from('incidents')
      .select('*')
      .order('latest_at', { ascending: false })
      .range(page * 50, page * 50 + 49)
    content = (
      <>
        {error ? (
          <p>Incident monitoring unavailable.</p>
        ) : !data?.length ? (
          <p>
            No incidents recorded. This does not prove the absence of failures
            before monitoring was activated.
          </p>
        ) : (
          data.map((i) => (
            <article key={i.key}>
              <h2>{i.impact}</h2>
              <p>
                {i.status} · {i.occurrences} occurrences · first{' '}
                {stamp(i.first_at)} · latest {stamp(i.latest_at)}
              </p>
              <details>
                <summary>Technical details</summary>
                <p>{i.key}</p>
                <p>Correlation {i.correlation_id}</p>
                <pre>{i.details}</pre>
              </details>
            </article>
          ))
        )}
        {pagination}
      </>
    )
  } else if (view === 'integrity')
    content = (
      <>
        <p>
          These checks inspect outcomes independently of worker heartbeat.
          Findings require review; no ambiguous picks or uncertain emails are
          automatically repaired.
        </p>
        <p>Last observation {stamp(check.data?.observed_at)}</p>
        {check.data ? (
          <pre>{JSON.stringify(check.data.findings, null, 2)}</pre>
        ) : (
          <p>No integrity checks recorded.</p>
        )}
        <Actions action="reconcile" />
        <Link href="/admin/picks">Inspect affected picks</Link>
      </>
    )
  else
    content = (
      <>
        <p>
          Backup and restore status:{' '}
          <strong>not verified in this environment</strong>. A backup job
          passing is insufficient; inspect its isolated restore result and
          encrypted artifact.
        </p>
        <p>
          Backups include new delivery, revision, campaign and operational
          tables. Run the encrypted backup workflow outside deadline traffic.
        </p>
        <a href="https://github.com/tylerherman19/Madness/actions/workflows/backup.yml">
          Backup and restore-check runs
        </a>
        <p>
          Recovery instructions: repository docs/reliability/RUNBOOK.md. Pause
          workers and email first; preserve queued work, then restore into an
          isolated database and compare row digests before any production
          recovery.
        </p>
        <Controls action="retention-preview" />
      </>
    )
  return (
    <section className="system-page">
      {heading}
      {content}
    </section>
  )
}
