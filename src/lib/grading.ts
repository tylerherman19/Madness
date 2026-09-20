import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game } from '@/types'
import { sendEliminationEmail, sleep, SEND_DELAY_MS } from './email'
import { logAudit } from './audit'

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
// already-eliminated players are ignored, so re-running after each new final
// (or after a manual result correction) is safe. Shared by the admin
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

  const { data: picks } = await db
    .from('picks')
    .select('id, player_id, team, players(id, full_name, email, status)')
    .eq('slate_id', slateId)

  const eliminated: string[] = []
  const advanced = new Set<string>()
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

    if (losers.has(pick.team)) {
      const reason = `Slate ${slateNumber}: picked ${pick.team} — ${
        game.result === 'tie' ? 'game ended in a tie' : 'lost'
      }`
      const { error: eliminateError } = await db
        .from('players')
        .update({ status: 'eliminated', elimination_slate: slateNumber, elimination_reason: reason })
        .eq('id', player.id)

      if (eliminateError) {
        // Leave player.status as 'alive' — next run (grading is idempotent)
        // will retry the elimination instead of a false "eliminated" report.
        console.error(`Failed to eliminate player ${player.id}:`, eliminateError)
        continue
      }

      eliminated.push(player.full_name)
      eliminatedPlayerIds.add(player.id)
      advanced.delete(player.full_name)
      await logAudit(db, {
        event_type: 'player-eliminated',
        actor: 'system',
        player_id: player.id,
        player_name: player.full_name,
        message: `${player.full_name} eliminated — ${reason}`,
        details: { slate_number: slateNumber, team: pick.team, result: game.result },
      })
      // Awaited: fire-and-forget sends can be dropped when the serverless
      // function is frozen after responding; paced for Resend's rate limit.
      if (player.email) {
        await sendEliminationEmail(player.email, player.full_name, pick.team, slateNumber)
        await sleep(SEND_DELAY_MS)
      }
    } else if (winners.has(pick.team)) {
      advanced.add(player.full_name)
    }
  }

  return { eliminated, advanced: [...advanced] }
}
