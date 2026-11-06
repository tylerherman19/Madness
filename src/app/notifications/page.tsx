import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { pageMetadata } from '@/lib/site'
import PoolShell from '@/app/components/PoolShell'
import s from '@/app/components/pp.module.css'
import Preferences from './Preferences'

// Linked from the privacy policy and pool emails, not the menu. Signed-out
// visitors log in and come straight back here.
export const metadata = pageMetadata('Email preferences', 'Choose which Pick and Pray emails you receive.', '/notifications', false)

export default async function NotificationsPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/notifications')
  const db = await getDb()
  const [pool, { data, error }] = await Promise.all([
    getPoolConfig(db),
    db.from('players').select('notifications_enabled').eq('id', session.player_id).single(),
  ])
  return (
    <PoolShell mode={pool.competition_mode} seasonYear={pool.season_year} account={session.full_name} width="narrow">
      <h1 className={s.title}>Email preferences</h1>
      <p className={s.authLede}>Signed in as {session.full_name}.</p>
      {error || !data
        ? <p role="status" className={s.notice}>Preferences are unavailable right now. Try again later.</p>
        : <div className={s.authForm}><Preferences enabled={data.notifications_enabled} /></div>}
    </PoolShell>
  )
}
