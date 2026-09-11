import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireCronOrAdmin } from '@/lib/api'
import { slateDeadline, autoAssignTeam, seedForTeam } from '@/lib/deadline'
import { sendEliminationEmail, sendPickConfirmationEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import type { Game, Slate } from '@/types'

// Per-player DB round trips plus awaited emails — allow a big no-pick cohort.
export const maxDuration = 300

// Vercel Cron (vercel.json). Games happen every day now, so this runs daily
// and guards itself on the slate's own lock time rather than on a fixed
// weekly cutoff: if the first tip hasn't happened yet it is a no-op, and
// re-running afterwards is harmless because everyone then has a pick.
//
// A player who missed the lock is assigned a team from the latest game of the
// day they haven't already used (see autoAssignTeam). Elimination is the
// fallback for the one case that cannot be assigned: every team on the slate
// is already spent.
export async function GET(req: NextRequest) {
  const unauthorized = await requireCronOrAdmin(req)
  if (unauthorized) return unauthorized

  try {
    const supabase = await getDb()
    const { data: slate } = await supabase
      .from('slates')
      .select('*')
      .eq('is_active', true)
      .single()

    if (!slate) return NextResponse.json({ ok: true, message: 'No active slate' })

    const { data: games } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', slate.id)

    if (!games || games.length === 0) {
      return NextResponse.json({ ok: true, message: 'No games found' })
    }

    const gamesData: Game[] = games

    // Only act once the slate has locked (in test mode, against the
    // sandbox's simulated clock).
    const deadline = slateDeadline(slate, gamesData)
    const now = await getEffectiveNow()
    if (!deadline || now < deadline) {
      return NextResponse.json({ ok: true, message: 'Slate has not locked yet' })
    }

    // Find alive players without a pick for this slate
    const { data: alivePlayers } = await supabase
      .from('players')
      .select('id, full_name, email')
      .eq('status', 'alive')

    if (!alivePlayers || alivePlayers.length === 0) {
      return NextResponse.json({ ok: true, message: 'No alive players' })
    }

    const { data: existingPicks } = await supabase
      .from('picks')
      .select('player_id')
      .eq('slate_id', slate.id)

    const playersWithPicks = new Set(
      (existingPicks || []).map((p: { player_id: string }) => p.player_id)
    )

    const playersWithoutPick = alivePlayers.filter(
      (p: { id: string }) => !playersWithPicks.has(p.id)
    )

    const results = []

    for (const player of playersWithoutPick) {
      // Get this player's used teams
      const { data: pastPicks } = await supabase
        .from('picks')
        .select('team')
        .eq('player_id', player.id)

      const usedTeams = new Set((pastPicks || []).map((p: { team: string }) => p.team))

      const autoTeam = autoAssignTeam(gamesData, [...usedTeams])

      if (autoTeam) {
        const { error: insertError } = await supabase.from('picks').insert({
          player_id: player.id,
          slate_id: slate.id,
          team: autoTeam,
          seed: seedForTeam(autoTeam, gamesData),
          auto_assigned: true,
          submitted_by_admin: false,
        })
        if (insertError) {
          // e.g. the player submitted a pick between our read and this write
          results.push({ player: player.full_name, action: `skipped: ${insertError.message}` })
          continue
        }

        await logAudit(supabase, {
          event_type: 'pick-auto-assigned',
          actor: 'system',
          player_id: player.id,
          player_name: player.full_name,
          message: `${player.full_name} missed the Slate ${slate.slate_number} deadline — auto-assigned ${autoTeam}`,
          details: { slate_number: slate.slate_number, team: autoTeam },
        })

        // Awaited: fire-and-forget sends can be dropped when the serverless
        // function is frozen after responding. Failures are logged inside the
        // sender; the assignment itself already succeeded.
        if (player.email) {
          await sendPickConfirmationEmail(player.email, player.full_name, autoTeam, slate.slate_number)
        }

        results.push({ player: player.full_name, action: `auto-assigned ${autoTeam}` })
      } else {
        const reason = 'Missed the lock — every team on the slate was already used'
        const { error: eliminateError } = await supabase
          .from('players')
          .update({
            status: 'eliminated',
            elimination_slate: slate.slate_number,
            elimination_reason: reason,
          })
          .eq('id', player.id)

        if (eliminateError) {
          // Leave player alive — next cron run (this deadline check still
          // passes) retries instead of falsely reporting them eliminated.
          results.push({ player: player.full_name, action: `skipped: ${eliminateError.message}` })
          continue
        }

        await logAudit(supabase, {
          event_type: 'player-eliminated',
          actor: 'system',
          player_id: player.id,
          player_name: player.full_name,
          message: `${player.full_name} eliminated — ${reason}`,
          details: { slate_number: slate.slate_number, cause: 'missed-deadline' },
        })

        if (player.email) {
          await sendEliminationEmail(player.email, player.full_name, null, slate.slate_number)
        }

        results.push({ player: player.full_name, action: 'eliminated (no auto-assign available)' })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error('auto-assign error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
