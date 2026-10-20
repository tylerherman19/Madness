import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import PoolShell from '@/app/components/PoolShell'
import s from '@/app/components/pp.module.css'
import Preferences from './Preferences'

export default async function NotificationsPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  const db = await getDb()
  const [pool, { data, error }] = await Promise.all([
    getPoolConfig(db),
    db.from('players').select('notifications_enabled').eq('id', session.player_id).single(),
  ])
  return (
    <PoolShell mode={pool.competition_mode} seasonYear={pool.season_year} account={session.full_name} width="narrow">
      <div className={s.kicker}>{session.full_name}</div>
      <h1 className={s.title}>Alerts</h1>
      {error ? <p className={s.notice}>Preferences are temporarily unavailable. Please try again later.</p> : <Preferences enabled={data.notifications_enabled} />}
    </PoolShell>
  )
}
