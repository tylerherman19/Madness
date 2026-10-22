import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import BroadcastForm from './BroadcastForm'

export const metadata = { title: 'Pool Email', description: 'Madness pool administration: pool email.' }

export default async function AdminEmailPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const {data:counts,error}=await supabase.rpc('contest_counts')
  if(error)return <p>Audience counts unavailable. Verify migrations and database access.</p>
  const slate=counts.requirement
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Email Players</h1>
      </div>
      <BroadcastForm
        counts={{
          all: counts.players,
          alive: counts.alive,
          unpicked: slate ? counts.unpicked : null,
        }}
        slateNumber={slate?.slate_number ?? null}
      />
    </div>
  )
}
