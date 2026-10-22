import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
export default async function Picks({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; player?: string }>
}) {
  if (!(await getAdminSession())) redirect('/admin/login')
  const query = await searchParams,
    page = Math.max(0, Number(query.page) || 0),
    db = await getDb()
  let read = db
    .from('picks')
    .select(
      'id,player_id,slate_id,team,version,updated_at,auto_assigned,submitted_by_admin,players(full_name),slates(locks_at,slate_date)',
      { count: 'exact' },
    )
    .order('updated_at', { ascending: false })
    .order('id')
    .range(page * 50, page * 50 + 49)
  if (query.player) read = read.eq('player_id', query.player)
  const { data, error, count } = await read
  return (
    <section className="system-page">
      <h1>Picks and receipts</h1>
      <p>
        Accepted timestamps and versions come from the database. Open an entry
        for its revision and notification history.
      </p>
      {error ? (
        <p>Pick records unavailable.</p>
      ) : (
        <>
          <p>{count} accepted selections</p>
          <div className="system-table">
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Selection</th>
                  <th>Origin</th>
                  <th>Version / accepted</th>
                  <th>Period</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/players/${p.player_id}`}>
                        {(p.players as unknown as { full_name: string })
                          ?.full_name ?? p.player_id}
                      </Link>
                    </td>
                    <td>{p.team}</td>
                    <td>
                      {p.auto_assigned
                        ? 'Automatic'
                        : p.submitted_by_admin
                          ? 'Administrator'
                          : 'Manual'}
                    </td>
                    <td>
                      {p.version} · {p.updated_at}
                    </td>
                    <td>
                      {
                        (p.slates as unknown as { slate_date: string })
                          ?.slate_date
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav>
            {page > 0 && <Link href={`?page=${page - 1}`}>Previous</Link>} Page{' '}
            {page + 1}{' '}
            {(page + 1) * 50 < (count ?? 0) && (
              <Link href={`?page=${page + 1}`}>Next</Link>
            )}
          </nav>
        </>
      )}
    </section>
  )
}
