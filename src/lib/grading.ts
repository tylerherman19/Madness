import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game } from '@/types'
import { selectAll } from './db'
import { reportFailure } from './alerts'

export interface GradeResult {
  eliminated: string[]
  advanced: string[]
}

// Teams that have already lost or tied in a decided (non-pending) game —
// picking one of these means elimination once grading runs. Shared by
// gradeSlatePicks (which acts on it) and countPendingEliminations (which
// just previews it before the admin hits "Grade").
function computeLosers(games: Game[]): Set<string> {
  const losers = new Set<string>() // includes both teams of a tie
  for (const g of games) {
    if (g.result === 'home_win') losers.add(g.away_team)
    else if (g.result === 'away_win') losers.add(g.home_team)
    else if (g.result === 'tie') { losers.add(g.home_team); losers.add(g.away_team) }
  }
  return losers
}

// Alive players whose pick has already lost (or tied) in a game that's been
// decided but not yet graded — i.e. what "Grade All Picks" is about to do.
export function countPendingEliminations(
  picks: { team: string; playerStatus: string; playerId?: string }[],
  games: Game[]
): number {
  const losers = computeLosers(games)
  const eliminatedPlayers = new Set<string>()
  let anonymousLosses = 0
  for (const pick of picks) {
    if (pick.playerStatus !== 'alive' || !losers.has(pick.team)) continue
    if (pick.playerId) eliminatedPlayers.add(pick.playerId)
    else anonymousLosses++
  }
  return eliminatedPlayers.size + anonymousLosses
}

// Grade every pick for a slate against its completed games: a loss
// eliminates, a win advances, an unfinished game is skipped. Idempotent —
// already-eliminated players are ignored. Result corrections require an explicit replay. Shared by the admin
// grade-slate endpoint and the sync-results cron.
export async function gradeSlatePicks(
  db: SupabaseClient,
  slateId: string,
  slateNumber: number,
  completedGames: Game[]
): Promise<GradeResult> {
  const winners = new Set<string>()
  for (const g of completedGames) {
    if (g.result === 'home_win') winners.add(g.home_team)
    else if (g.result === 'away_win') winners.add(g.away_team)
  }
  const losers = computeLosers(completedGames)

  const picks = await selectAll<{
    id: string; player_id: string; team: string; loss_excused?: boolean
    players: { id: string; full_name: string; email: string; status: string } | null
  }>((from, to) => db.from('picks')
    .select('id, player_id, team, loss_excused, players(id, full_name, email, status)')
    .eq('slate_id', slateId).order('id').range(from, to))

  const eliminated: string[] = []
  const advanced = new Map<string, string>()
  const eliminatedPlayerIds = new Set<string>()

  for (const pick of picks ?? []) {
    const player = pick.players as unknown as {
      id: string
      full_name: string
      email: string
      status: string
    } | null
    if (!player || player.status !== 'alive' || eliminatedPlayerIds.has(player.id)) continue

    const game = completedGames.find(
      (g) => g.home_team === pick.team || g.away_team === pick.team
    )
    if (!game) continue // game not final yet — graded on a later run

    if (!pick.loss_excused && losers.has(pick.team)) {
      const reason = `Slate ${slateNumber}: picked ${pick.team} — ${
        game.result === 'tie' ? 'game ended in a tie' : 'lost'
      }`
      const { data: didEliminate, error: eliminateError } = await db.rpc('grade_pick_loss', {
        p_pick_id: pick.id, p_slate_number: slateNumber, p_reason: reason,
      })

      if (eliminateError) {
        // Leave player.status as 'alive' — next run (grading is idempotent)
        // will retry the elimination instead of a false "eliminated" report.
        console.error(`Failed to eliminate player ${player.id}:`, eliminateError)
        await reportFailure(db, {
          kind: 'job-failed',
          source: 'grading',
          key: `grading:${player.id}`,
          message: `Couldn't eliminate ${player.full_name} on Slate ${slateNumber} (will retry next grade)`,
          error: eliminateError,
        })
        throw eliminateError
      }

      if (!didEliminate) continue // Re-read under the player lock: restoration and concurrent grading win safely.
      eliminated.push(player.full_name)
      eliminatedPlayerIds.add(player.id)
      advanced.delete(player.id)
      // Notification delivery is independent of grading (migration 022 outbox).
    } else if ((pick.loss_excused || winners.has(pick.team)) && picks.filter(row => row.player_id === player.id).every(row => row.loss_excused || winners.has(row.team))) {
      advanced.set(player.id, player.full_name)
    }
  }

  return { eliminated, advanced: [...advanced.values()] }
}
