import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import ScheduleForm from './ScheduleForm'
import type { Game, Slate } from '@/types'
import { getTeamAbbrs } from '@/lib/teams'

export default async function SchedulePage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const { data: slates } = await supabase
    .from('slates')
    .select('*')
    .order('slate_date')

  const { data: activeSlate } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .single()

  const teams = await getTeamAbbrs(supabase)

  let games: Game[] = []
  if (activeSlate) {
    const { data } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', activeSlate.id)
      .order('tip_time')
    games = data || []
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Schedule</h1>
      <ScheduleForm
        slates={(slates || []) as Slate[]}
        activeSlate={activeSlate as Slate | null}
        games={games}
        teams={teams}
      />
    </div>
  )
}
