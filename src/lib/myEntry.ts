import 'server-only'
import { getDb } from './testMode'
import { didPickWin } from './deadline'
import type { Game } from '@/types'

// The signed-in player's own picks for the season, with results. Only ever
// read for the session's own player, so nothing here needs the reveal rule.
export interface MyPick {
  slateId: string
  team: string
  autoAssigned: boolean
  result: 'won' | 'lost' | 'pending'
}

export async function loadMyPicks(playerId: string, slateIds: string[]): Promise<MyPick[]> {
  if (!slateIds.length) return []
  const db = await getDb()
  const { data: picks, error } = await db
    .from('picks')
    .select('slate_id, team, auto_assigned, loss_excused')
    .eq('player_id', playerId)
    .in('slate_id', slateIds)
  if (error || !picks?.length) return []
  const pickSlates = [...new Set(picks.map((p: { slate_id: string }) => p.slate_id))]
  const { data: games } = await db
    .from('games')
    .select('slate_id, home_team, away_team, result')
    .in('slate_id', pickSlates)
  const slateGames = (games ?? []) as Game[]
  return picks.map((p: { slate_id: string; team: string; auto_assigned: boolean | null; loss_excused?: boolean }) => {
    const game = slateGames.find((g) => g.slate_id === p.slate_id && (g.home_team === p.team || g.away_team === p.team))
    const result: MyPick['result'] = !game || game.result === 'pending' ? 'pending' : didPickWin(p, slateGames) ? 'won' : 'lost'
    return { slateId: p.slate_id, team: p.team, autoAssigned: !!p.auto_assigned, result }
  })
}
