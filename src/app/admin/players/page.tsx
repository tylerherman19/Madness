import { allRows } from '@/lib/db'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import PlayersManager from './PlayersManager'
import type { Player } from '@/types'
import { loadAll } from '@/lib/seasonData'

export const metadata = { title: 'Manage Players', description: 'Pick and Pray administration: manage players.' }

export default async function PlayersPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const { data: players } = await allRows(supabase
    .from('players')
    .select('id, full_name, email, phone, venmo_handle, paid, status, elimination_slate, elimination_reason')
    .order('status')
    .order('full_name'))

  const { data: activeSlate } = await supabase
    .from('slates')
    .select('id, slate_number, slate_date')
    .eq('is_active', true)
    .single()

  const { data: picksData } = activeSlate
    ? await allRows(supabase.from('picks').select('id,player_id,team,updated_at').eq('slate_id', activeSlate.id))
    : { data: [] }

  const { data: dayGames } = activeSlate
    ? await supabase.from('games').select('home_team, away_team').eq('slate_id', activeSlate.id).order('tip_time')
    : { data: [] }

  const allPicks = await loadAll<{ player_id: string; team: string }>(supabase, 'picks', 'player_id, team')
  const weeksSurvived: Record<string, number> = {}
  const usedTeams: Record<string, string[]> = {}
  for (const p of allPicks || []) {
    weeksSurvived[p.player_id] = (weeksSurvived[p.player_id] || 0) + 1
    ;(usedTeams[p.player_id] ??= []).push(p.team)
  }
  const currentPicks: Record<string, string> = Object.fromEntries(
    (picksData || []).map((p: { player_id: string; team: string }) => [p.player_id, p.team])
  )

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <h1 className="font-display text-4xl" style={{ color: 'var(--ink)' }}>MANAGE PLAYERS</h1>
      <PlayersManager
        players={(players || []) as Player[]}
        activeWeekId={activeSlate?.id || null}
        activeWeekNumber={activeSlate?.slate_number || null}
        activeDate={activeSlate?.slate_date ?? null}
        dayGames={(dayGames ?? []) as { home_team: string; away_team: string }[]}
        usedTeams={usedTeams}
        pickReceipts={Object.fromEntries((picksData??[]).map(p=>[p.player_id,{id:p.id,updatedAt:p.updated_at}]))}
        currentPicks={currentPicks}
        weeksSurvived={weeksSurvived}
      />
    </div>
  )
}
