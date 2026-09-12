import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { countPendingEliminations } from '@/lib/grading'
import ResultsForm from './ResultsForm'
import type { Game, Slate } from '@/types'

export default async function ResultsPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const { data: activeSlate } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .single()

  let games: Game[] = []
  let pendingEliminations = 0
  if (activeSlate) {
    const { data } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', activeSlate.id)
      .order('tip_time')
    games = data || []

    const { data: pickRows } = await supabase
      .from('picks')
      .select('team, players(status)')
      .eq('slate_id', activeSlate.id)
    const picks = (pickRows || []).map((p) => ({
      team: p.team as string,
      playerStatus: (p.players as unknown as { status: string } | null)?.status ?? '',
    }))
    pendingEliminations = countPendingEliminations(picks, games)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Enter Results</h1>
      {!activeSlate ? (
        <p className="text-slate-400">No active slate. Set up the schedule first.</p>
      ) : (
        <ResultsForm slate={activeSlate as Slate} games={games} pendingEliminations={pendingEliminations} />
      )}
    </div>
  )
}
