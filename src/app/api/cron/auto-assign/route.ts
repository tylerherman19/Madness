import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireCronOrAdmin } from '@/lib/api'
import { slateDeadline, autoAssignTeam, seedForTeam } from '@/lib/deadline'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, sharedRoundPickQuota } from '@/lib/competition'
import { sendEliminationEmail, sendPickConfirmationEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import type { Game } from '@/types'

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

    const pool = await getPoolConfig(supabase)
    const { data: seasonSlates } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, locks_at')
      .eq('season_year', slate.season_year)
    const seasonSlateIds = (seasonSlates ?? []).map((row) => row.id)
    const { data: seasonGames } = seasonSlateIds.length
      ? await supabase.from('games').select('*').in('slate_id', seasonSlateIds)
      : { data: [] as Game[] }
    const allGames: Game[] = seasonGames || []
    const games = allGames.filter((game) => game.slate_id === slate.id)

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

    const periods = buildPickPeriods(pool.competition_mode, seasonSlates ?? [], allGames)
    const activePeriod = periods.find((period) => period.id === slate.id)
    const sharedQuota = sharedRoundPickQuota(
      pool.competition_mode,
      pool.pick_frequency,
      activePeriod?.round ?? null
    )
    const eligibleSlateIds = sharedQuota
      ? new Set(periods.filter((period) => period.round === activePeriod?.round).map((period) => period.id))
      : new Set([slate.id])

    // A shared round stays open across its playing days. Missing selections
    // are filled only after the last slate locks, so nobody is forced into a
    // first-day team when they still had the second day available.
    if (sharedQuota) {
      const lastRoundSlate = periods
        .filter((period) => period.round === activePeriod?.round)
        .sort((a, b) => a.date.localeCompare(b.date))
        .at(-1)
      if (lastRoundSlate?.id !== slate.id) {
        return NextResponse.json({ ok: true, message: 'Round remains open on a later game day' })
      }
    }

    // Find alive players who have not completed this slate or round quota.
    const { data: alivePlayers } = await supabase
      .from('players')
      .select('id, full_name, email')
      .eq('status', 'alive')

    if (!alivePlayers || alivePlayers.length === 0) {
      return NextResponse.json({ ok: true, message: 'No alive players' })
    }

    const { data: existingPicks } = await supabase
      .from('picks')
      .select('player_id, team, slate_id')

    const requiredPicks = sharedQuota ?? 1
    const periodPickCount = new Map<string, number>()
    for (const pick of existingPicks ?? []) {
      if (!eligibleSlateIds.has(pick.slate_id)) continue
      periodPickCount.set(pick.player_id, (periodPickCount.get(pick.player_id) ?? 0) + 1)
    }

    const playersWithoutPick = alivePlayers.filter(
      (player: { id: string }) => (periodPickCount.get(player.id) ?? 0) < requiredPicks
    )

    const results = []

    for (const player of playersWithoutPick) {
      const usedTeams = new Set(
        (existingPicks || [])
          .filter((pick: { player_id: string }) => pick.player_id === player.id)
          .map((pick: { team: string }) => pick.team)
      )
      const missing = requiredPicks - (periodPickCount.get(player.id) ?? 0)
      const autoTeams: string[] = []
      for (let index = 0; index < missing; index++) {
        const autoTeam = autoAssignTeam(gamesData, [...usedTeams])
        if (!autoTeam) break
        autoTeams.push(autoTeam)
        usedTeams.add(autoTeam)
      }

      if (autoTeams.length === missing) {
        const { error: insertError } = await supabase.from('picks').insert(
          autoTeams.map((autoTeam) => ({
            player_id: player.id,
            slate_id: slate.id,
            team: autoTeam,
            seed: seedForTeam(autoTeam, gamesData),
            auto_assigned: true,
            submitted_by_admin: false,
          }))
        )
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
          message: `${player.full_name} missed the Slate ${slate.slate_number} deadline — auto-assigned ${autoTeams.join(', ')}`,
          details: { slate_number: slate.slate_number, teams: autoTeams, required_picks: requiredPicks },
        })

        // Awaited: fire-and-forget sends can be dropped when the serverless
        // function is frozen after responding. Failures are logged inside the
        // sender; the assignment itself already succeeded.
        if (player.email) {
          for (const autoTeam of autoTeams) {
            await sendPickConfirmationEmail(player.email, player.full_name, autoTeam, slate.slate_number)
          }
        }

        results.push({ player: player.full_name, action: `auto-assigned ${autoTeams.join(', ')}` })
      } else {
        const reason = sharedQuota
          ? `Missed the round quota — needed ${missing} more pick${missing === 1 ? '' : 's'}`
          : 'Missed the lock — every team on the slate was already used'
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
