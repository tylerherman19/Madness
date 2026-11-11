import { allRows, selectAll } from '@/lib/db'
import { getActivePoolId, contestFilter } from '@/lib/pool'
import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import PlayersManager from './PlayersManager'
import type { Player } from '@/types'
import { getTeamAbbrs } from '@/lib/teams'

export const metadata = { title: 'Manage Players', description: 'Pick and Pray administration: manage players.' }

export default async function PlayersPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()
  // The active contest's entries; archived contests are under /history.
  const poolId = await getActivePoolId(supabase)

  const { data: players } = await allRows(supabase
    .from('players')
    .select('id, full_name, email, phone, venmo_handle, paid, status, elimination_slate, elimination_reason')
    .match(contestFilter(poolId))
    .order('status')
    .order('full_name'))

  const { data: activeSlate } = await supabase
    .from('slates')
    .select('id, slate_number')
    .eq('is_active', true)
    .single()

  const { data: picksData } = activeSlate
    ? await allRows(supabase.from('picks').select('id,player_id,team,updated_at').eq('slate_id', activeSlate.id).match(contestFilter(poolId)))
    : { data: [] }

  const teams = await getTeamAbbrs(supabase)

  const allPicks = await selectAll<{ player_id: string }>((from, to) => supabase.from('picks').select('player_id').match(contestFilter(poolId)).order('id').range(from, to))
  const weeksSurvived: Record<string, number> = {}
  for (const p of allPicks || []) {
    weeksSurvived[p.player_id] = (weeksSurvived[p.player_id] || 0) + 1
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
        teams={teams}
        pickReceipts={Object.fromEntries((picksData??[]).map(p=>[p.player_id,{id:p.id,updatedAt:p.updated_at}]))}
        currentPicks={currentPicks}
        weeksSurvived={weeksSurvived}
      />
    </div>
  )
}
