import { NextRequest, NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { getSession, getAdminSession } from '@/lib/session'
import { isUuid } from '@/lib/api'
import { isSlateLocked, seedForTeam } from '@/lib/deadline'
import { loadPickWindow } from '@/lib/pickWindow'
import { buildPickPeriods, sharedRoundPickQuota } from '@/lib/competition'
import { sendPickConfirmationEmail } from '@/lib/email'
import { pickWriteError } from '@/lib/pickErrors'
import type { Game } from '@/types'
import { checkRateLimit } from '@/lib/rateLimit'
import { serverError } from '@/lib/alerts'

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

    const { allowed } = await checkRateLimit(`pick:${playerId}`, 30, 60)
    if (!allowed) return NextResponse.json({ error: 'Too many pick changes. Try again in a minute.' }, { status: 429, headers: { 'Retry-After': '60' } })

    if (!slate_id || typeof team !== 'string' || !team || team.length > 80) {
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
    const pool = await getPoolConfig(supabase, true)

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

    const now = await getEffectiveNow()
    const window = await loadPickWindow(supabase, playerId, pool, now, !isAdmin)
    const slate = window.seasonSlates.find((row) => row.id === slate_id)
    if (!slate || (isAdmin ? !slate.is_active : window.pickSlate?.id !== slate_id)) {
      return NextResponse.json(
        { error: 'This game day is not open for you yet. Your previous pick must finish with a win first.' },
        { status: 400 }
      )
    }

    const seasonSlates = window.seasonSlates
    const playerPicks = window.picks
    const allGames: Game[] = window.games
    if (playerPicks.some(pick => {
      if (pick.loss_excused) return false
      const game = allGames.find(game => game.slate_id === pick.slate_id && (game.home_team === pick.team || game.away_team === pick.team))
      return game && (game.result === 'tie' || (game.result === 'home_win' && game.away_team === pick.team) || (game.result === 'away_win' && game.home_team === pick.team))
    })) return NextResponse.json({ error: 'A previous pick lost. Your entry is no longer eligible.' }, { status: 403 })
    const gamesData = allGames.filter((game) => game.slate_id === slate_id)
    const teamGame = gamesData.find((g) => g.home_team === team || g.away_team === team)

    if (!teamGame) {
      return NextResponse.json({ error: `${team} is not playing this slate` }, { status: 400 })
    }

    // The whole slate locks at its first tip — there is no per-team deadline
    // any more, so submitting and changing a pick close at the same instant.
    // Admins can still submit manually after the lock.
    if (!isAdmin) {
      // Refresh the clock after ESPN and database reads. A request that began
      // just before first tip cannot save after the deadline passed.
      const submissionNow = await getEffectiveNow()
      if (isSlateLocked(slate, gamesData, submissionNow)) {
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
        .eq('team', existingPick.team)
        .select('id, team, slate_id')
        .single()
      if (updateError) {
        const expected = pickWriteError(updateError)
        if (expected) return NextResponse.json({ error: expected.message }, { status: expected.status })
        return serverError('api/picks', updateError, 'Could not save your pick. Try again.')
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
        const expected = pickWriteError(insertError)
        if (expected) return NextResponse.json({ error: expected.message }, { status: expected.status })
        return serverError('api/picks', insertError, 'Could not save your pick. Try again.')
      }
      savedPick = inserted
    }

    // Migration 022 records exactly one audit event in the pick transaction.

    // Awaited: fire-and-forget sends can be dropped when the serverless
    // function is frozen after responding. The pick is already saved, so a
    // failed send (logged inside the sender) doesn't fail the request.
    if (player.email) {
      await sendPickConfirmationEmail(player.email, player.full_name, team, slate.slate_number)
    }

    revalidateContest()
    return NextResponse.json({ ok: true, pick: savedPick })
  } catch (err) {
    return serverError('api/picks', err)
  }
}
