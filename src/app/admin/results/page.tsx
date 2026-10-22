import {allRows} from '@/lib/db'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { countPendingEliminations } from '@/lib/grading'
import ResultsForm from './ResultsForm'
import type { Game, Slate } from '@/types'

export const metadata = { title: 'Game Results', description: 'Madness pool administration: game results.' }

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

    const { data: pickRows } = await allRows(supabase.from('picks').select('player_id,team,players(status)').eq('slate_id',activeSlate.id))
    const picks = (pickRows || []).map((p) => ({
      playerId:p.player_id,
      team: p.team as string,
      playerStatus: (p.players as unknown as { status: string } | null)?.status ?? '',
    }))
    pendingEliminations = countPendingEliminations(picks, games)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-ink">Enter Results</h1>
      <p>{games.filter(g=>g.result!=='pending'&&g.graded_at).length} finals graded · {games.filter(g=>g.result!=='pending'&&!g.graded_at).length} awaiting grading. Last feed observation: {(activeSlate as {result_checked_at?:string}|null)?.result_checked_at??'Not observed'}</p>
      {!activeSlate ? (
        <p className="text-muted">No active slate. Set up the schedule first.</p>
      ) : (
        <ResultsForm slate={activeSlate as Slate} games={games} pendingEliminations={pendingEliminations} />
      )}
    </div>
  )
}
