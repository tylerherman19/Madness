import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import Preferences from './Preferences'
export default async function NotificationsPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  const db = await getDb()
  const { data, error } = await db.from('players').select('notifications_enabled').eq('id', session.player_id).single()
  return <main id="main" className="mx-auto max-w-lg p-8"><h1>Notifications</h1>{error ? <p>Preferences are temporarily unavailable. Please try again later.</p> : <Preferences enabled={data.notifications_enabled} />}</main>
}
