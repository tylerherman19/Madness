import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { isUuid } from '@/lib/api'
export default async function Entry({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string }>
}) {
  if (!(await getAdminSession())) redirect('/admin/login')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const page = Math.max(0, Number((await searchParams).page) || 0),
    db = await getDb()
  const [player, revisions] = await Promise.all([
    db
      .from('players')
      .select('id,full_name,status,paid,elimination_reason')
      .eq('id', id)
      .maybeSingle(),
    db
      .from('pick_revisions')
      .select(
        'id,pick_id,slate_id,version,previous_team,team,actor,origin,reason,rule_version,accepted_at',
      )
      .eq('player_id', id)
      .order('accepted_at', { ascending: false })
      .range(page * 50, page * 50 + 49),
  ])
  if (!player.data && !player.error) notFound()
  return (
    <section className="system-page">
      <h1>{player.data?.full_name ?? 'Entry unavailable'}</h1>
      <p>
        {player.data?.status} · {player.data?.paid ? 'Paid' : 'Unpaid'} ·{' '}
        {player.data?.elimination_reason}
      </p>
      <p>
        <Link href={`/admin/picks?player=${id}`}>Current selections</Link> ·{' '}
        <Link href={`/admin/system/email?player=${id}`}>
          Notification history
        </Link>
      </p>
      <h2>Revision history</h2>
      {revisions.error ? (
        <p>Revision history unavailable.</p>
      ) : revisions.data?.length ? (
        revisions.data.map((r) => (
          <article key={r.id}>
            <h3>
              Revision {r.version}:{' '}
              {r.previous_team ? `${r.previous_team} → ` : ''}
              {r.team}
            </h3>
            <p>
              Accepted {r.accepted_at} · {r.origin} · actor {r.actor}
            </p>
            <p>
              {r.reason ?? 'No correction reason recorded'} · rule version{' '}
              {r.rule_version ?? 'Unavailable for legacy pick'}
            </p>
            <p>
              <Link href="/admin/system/jobs">Assignment and grading jobs</Link>
            </p>
            <details>
              <summary>Record identity</summary>
              <p>
                Pick {r.pick_id} · period {r.slate_id}
              </p>
            </details>
          </article>
        ))
      ) : (
        <p>
          No revisions recorded. Legacy picks accepted before this migration
          remain in Picks and Audit history.
        </p>
      )}
      <nav>
        {page > 0 && <Link href={`?page=${page - 1}`}>Previous</Link>} Page{' '}
        {page + 1} <Link href={`?page=${page + 1}`}>Next</Link>
      </nav>
    </section>
  )
}
