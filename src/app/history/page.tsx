import Link from 'next/link'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { pageMetadata } from '@/lib/site'
import { MODE_LABEL, type CompetitionMode } from '@/lib/competition'
import PoolShell from '@/app/components/PoolShell'
import s from '@/app/components/pp.module.css'

export const metadata = pageMetadata('Past Contests', 'Final standings and picks from finished Pick and Pray contests.', '/history', false)

interface ContestListItem {
  id: string
  name: string
  competition_mode: CompetitionMode
  season_year: number
  starts_on: string | null
  ended_on: string | null
  entries: number
}

// Finished contests (migration 030 keeps their entries and picks). Each links
// to its final standings and every pick.
export default async function HistoryPage() {
  const pool = await getPoolConfig()
  let contests: ContestListItem[] = []
  let unavailable = false
  try {
    const { data, error } = await (await getDb()).rpc('contest_history_list')
    if (error) throw error
    contests = (data ?? []) as ContestListItem[]
  } catch {
    unavailable = true
  }

  return (
    <PoolShell mode={pool.competition_mode} seasonYear={pool.season_year}>
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}>History</div>
          <h1 className={s.title}>Past contests</h1>
        </div>
      </div>
      {unavailable ? (
        <p className={s.notice}>Past contests are unavailable right now. Try again shortly.</p>
      ) : contests.length === 0 ? (
        <p className={s.notice}>No finished contests yet.</p>
      ) : (
        <table className={s.gridTable}>
          <thead>
            <tr><th scope="col">Contest</th><th scope="col">Format</th><th scope="col">Dates</th><th scope="col">Entries</th></tr>
          </thead>
          <tbody>
            {contests.map((contest) => (
              <tr key={contest.id}>
                <th scope="row"><Link href={`/history/${contest.id}`}>{contest.name} · {contest.season_year}</Link></th>
                <td>{MODE_LABEL[contest.competition_mode] ?? contest.competition_mode}</td>
                <td>{[contest.starts_on, contest.ended_on].filter(Boolean).join(' – ') || '–'}</td>
                <td>{contest.entries}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PoolShell>
  )
}
