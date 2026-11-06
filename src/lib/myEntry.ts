import 'server-only'
import { getDb } from './testMode'

// The signed-in player's own picks for the season. Only ever read for the
// session's own player, so nothing here needs the reveal rule.
export interface MyPick {
  slateId: string
  team: string
  autoAssigned: boolean
}

// Every pick the player has made. One player's picks are a few dozen rows a
// season, so callers filter to the season themselves: the read then needn't
// wait for the season's slate list, and no slate ids go in the URL.
export async function loadMyPicks(playerId: string): Promise<MyPick[]> {
  const db = await getDb()
  const { data: picks, error } = await db
    .from('picks')
    .select('slate_id, team, auto_assigned')
    .eq('player_id', playerId)
  if (error || !picks?.length) return []
  return picks.map((p: { slate_id: string; team: string; auto_assigned: boolean | null }) => ({
    slateId: p.slate_id,
    team: p.team,
    autoAssigned: !!p.auto_assigned,
  }))
}
