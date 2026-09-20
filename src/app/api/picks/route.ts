import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { getSession, getAdminSession } from '@/lib/session'
import { isUuid } from '@/lib/api'
import { isSlateLocked, seedForTeam } from '@/lib/deadline'
import { buildPickPeriods, sharedRoundPickQuota } from '@/lib/competition'
import { sendPickConfirmationEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import type { Game } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { slate_id, team, pick_id, player_id_override, submitted_by_admin } = body

    // Allow admin to submit on behalf of a player
    const isAdmin = submitted_by_admin ? await getAdminSession() : false
    let playerId: string

    if (isAdmin && player_id_override) {
      if (!isUuid(player_id_override)) {
        return NextResponse.json({ error: 'Invalid player_id_override' }, { status: 400 })
      }
      playerId = player_id_override
    } else {
      const session = await getSession()
      if (!session) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
      playerId = session.player_id
    }

    if (!slate_id || !team) {
      return NextResponse.json({ error: 'Missing slate_id or team' }, { status: 400 })
    }

    // No global team whitelist: the only teams that exist are the ones ESPN
    // listed, and the only legal picks are teams playing on this slate. The
    // "is not playing this slate" check further down enforces both at once.

    if (!isUuid(slate_id)) {
      return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })
    }
    if (pick_id && !isUuid(pick_id)) {
      return NextResponse.json({ error: 'Invalid pick_id' }, { status: 400 })
    }

    const supabase = await getDb()
    const pool = await getPoolConfig(supabase)

    // Check player is alive
    const { data: player } = await supabase
      .from('players')
      .select('id, email, full_name, status')
      .eq('id', playerId)
      .single()

    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 })
    if (player.status === 'eliminated') {
      return NextResponse.json({ error: 'You are eliminated' }, { status: 403 })
    }

    // Check slate is active
    const { data: slate } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year, is_active, locks_at')
      .eq('id', slate_id)
      .single()

    if (!slate?.is_active) {
      return NextResponse.json({ error: 'This slate is not active' }, { status: 400 })
    }

    const [{ data: seasonSlates }, { data: playerPicks }] = await Promise.all([
      supabase
        .from('slates')
        .select('id, slate_number, slate_date, locks_at')
        .eq('season_year', slate.season_year),
      supabase.from('picks').select('id, team, slate_id').eq('player_id', playerId),
    ])
    const seasonSlateIds = (seasonSlates ?? []).map((row) => row.id)
    const { data: seasonGames } = seasonSlateIds.length
      ? await supabase.from('games').select('*').in('slate_id', seasonSlateIds)
      : { data: [] as Game[] }
    const allGames: Game[] = seasonGames || []
    const gamesData = allGames.filter((game) => game.slate_id === slate_id)
    const teamGame = gamesData.find((g) => g.home_team === team || g.away_team === team)

    if (!teamGame) {
      return NextResponse.json({ error: `${team} is not playing this slate` }, { status: 400 })
    }

    // The whole slate locks at its first tip — there is no per-team deadline
    // any more, so submitting and changing a pick close at the same instant.
    // Admins can still submit manually after the lock.
    if (!isAdmin) {
      const now = await getEffectiveNow()
      if (isSlateLocked(slate, gamesData, now)) {
        return NextResponse.json(
          { error: 'Picks for today are locked — the first game has tipped off' },
          { status: 400 }
        )
      }
    }

    const periods = buildPickPeriods(pool.competition_mode, seasonSlates ?? [], allGames)
    const activePeriod = periods.find((period) => period.id === slate_id)
    const sharedQuota = sharedRoundPickQuota(
      pool.competition_mode,
      pool.pick_frequency,
      activePeriod?.round ?? null
    )
    const eligibleSlateIds = sharedQuota
      ? new Set(periods.filter((period) => period.round === activePeriod?.round).map((period) => period.id))
      : new Set([slate_id])
    const picksInPeriod = (playerPicks ?? []).filter((pick) => eligibleSlateIds.has(pick.slate_id))
    const quota = sharedQuota ?? 1

    let existingPick = pick_id
      ? (playerPicks ?? []).find((pick) => pick.id === pick_id && pick.slate_id === slate_id)
      : undefined

    // Daily pools retain the familiar replace-in-place behavior. Shared-round
    // pools add picks until their quota is full; changing one requires its ID.
    if (!sharedQuota && !existingPick) {
      existingPick = (playerPicks ?? []).find((pick) => pick.slate_id === slate_id)
    }
    if (pick_id && !existingPick) {
      return NextResponse.json({ error: 'That pick cannot be changed on this game day' }, { status: 400 })
    }
    if (!existingPick && picksInPeriod.length >= quota) {
      return NextResponse.json(
        { error: `You already made all ${quota} required pick${quota === 1 ? '' : 's'} for this round` },
        { status: 409 }
      )
    }

    const usedTeams = (playerPicks ?? [])
      .filter((pick) => pick.id !== existingPick?.id)
      .map((pick) => pick.team)
    if (usedTeams.includes(team)) {
      return NextResponse.json({ error: `${player.full_name} already used ${team}` }, { status: 400 })
    }

    // Snapshot the seed at pick time; the endgame tiebreak sums these and a
    // seed is only meaningful on the day the pick was made.
    const pickedSeed = seedForTeam(team, gamesData)

    // Re-submitting the same team is a no-op
    if (existingPick && existingPick.team === team) {
      return NextResponse.json({ ok: true, pick: existingPick })
    }

    let savedPick: { id: string; team: string; slate_id: string } | null = null
    if (existingPick) {
      // UPDATE in place — atomic, no window where the player has zero picks
      const { data: updated, error: updateError } = await supabase
        .from('picks')
        .update({ team, seed: pickedSeed, auto_assigned: false, submitted_by_admin: isAdmin })
        .eq('id', existingPick.id)
        .select('id, team, slate_id')
        .single()
      if (updateError) {
        console.error('update error', updateError)
        if (updateError.code === '23505') {
          return NextResponse.json({ error: `${player.full_name} already used ${team} in a previous slate` }, { status: 400 })
        }
        return NextResponse.json({ error: 'Failed to update pick' }, { status: 500 })
      }
      savedPick = updated
    } else {
      // submitted_by_admin records the verified admin session, never the
      // client-supplied flag — players can't stamp their own picks as admin's.
      const { data: inserted, error: insertError } = await supabase
        .from('picks')
        .insert({
          player_id: playerId,
          slate_id,
          team,
          seed: pickedSeed,
          auto_assigned: false,
          submitted_by_admin: isAdmin,
        })
        .select('id, team, slate_id')
        .single()
      if (insertError) {
        console.error('insert error', insertError)
        if (insertError.code === '23505') {
          return NextResponse.json({ error: `${player.full_name} already has a pick for this slate or already used ${team}` }, { status: 409 })
        }
        return NextResponse.json({ error: 'Failed to save pick' }, { status: 500 })
      }
      savedPick = inserted
    }

    await logAudit(supabase, {
      event_type: existingPick ? 'pick-changed' : 'pick-submitted',
      actor: isAdmin ? 'admin' : 'player',
      player_id: playerId,
      player_name: player.full_name,
      message: existingPick
        ? `${player.full_name} changed Slate ${slate.slate_number} pick: ${existingPick.team} → ${team}${isAdmin ? ' (by admin)' : ''}`
        : `${player.full_name} picked ${team} for Slate ${slate.slate_number}${isAdmin ? ' (by admin)' : ''}`,
      details: {
        slate_number: slate.slate_number,
        team,
        previous_team: existingPick?.team ?? null,
        required_picks: quota,
      },
    })

    // Awaited: fire-and-forget sends can be dropped when the serverless
    // function is frozen after responding. The pick is already saved, so a
    // failed send (logged inside the sender) doesn't fail the request.
    if (player.email) {
      await sendPickConfirmationEmail(player.email, player.full_name, team, slate.slate_number)
    }

    revalidatePath('/')
    return NextResponse.json({ ok: true, pick: savedPick })
  } catch (err) {
    console.error('picks error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
