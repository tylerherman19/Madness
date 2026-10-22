import {legacyPickPost} from '@/lib/legacyPickRoute'
import { NextRequest, NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { getSession, getAdminSession } from '@/lib/session'
import { isUuid } from '@/lib/api'
import { isSlateLocked,slateDeadline } from '@/lib/deadline'
import { loadPickWindow } from '@/lib/pickWindow'
import { buildPickPeriods, sharedRoundPickQuota } from '@/lib/competition'
import { randomUUID } from 'node:crypto'
import { adminSessionId } from '@/lib/session'
import { pickWriteError } from '@/lib/pickErrors'
import type { Game } from '@/types'
import { checkRateLimit } from '@/lib/rateLimit'
import { serverError } from '@/lib/alerts'

export async function POST(req: NextRequest) {
  if(process.env.TOURNAMENT_RELIABILITY_ENABLED!=='true')return legacyPickPost(req)
  try {
    const body = await req.json()
    const { slate_id, team, pick_id, expected_version, player_id_override, submitted_by_admin, request_id, reason } = body

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
    const requestId = request_id ?? randomUUID()
    if (!isUuid(requestId)) return NextResponse.json({ error: 'Invalid request ID' }, { status: 400 })
    const { data: prior, error: priorError } = await supabase.from('pick_requests').select('receipt,request').eq('player_id',playerId).eq('request_id',requestId).maybeSingle()
    if (priorError) throw priorError
    if (prior) {
      if (prior.request.team !== team || prior.request.slate !== slate_id) return NextResponse.json({ error:'Request ID reused with different selection' },{status:409})
      return NextResponse.json({ok:true,...prior.receipt})
    }
    const pool = await getPoolConfig(supabase, true)

    // Check player is alive
    const { data: player } = await supabase
      .from('players')
      .select('id, email, full_name, status, notifications_enabled')
      .eq('id', playerId)
      .single()

    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 })
    if (player.status === 'eliminated') {
      return NextResponse.json({ error: 'You are eliminated' }, { status: 403 })
    }

    const now = await getEffectiveNow()
    const window = await loadPickWindow(supabase, playerId, pool, now, !isAdmin)
    const retry = !request_id && window.picks.find(pick=>pick.slate_id===slate_id&&pick.team===team&&(!pick_id||pick.id===pick_id))
    if(retry) return NextResponse.json({ok:true,pick:retry,version:retry.version??1,acceptedAt:retry.updated_at,periodId:retry.slate_id,deadline:slateDeadline(window.seasonSlates.find(s=>s.id===retry.slate_id)??null,window.games.filter(g=>g.slate_id===retry.slate_id))})
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
    // An accepted identical retry returns the durable saved receipt, including
    // in a shared round where inserts otherwise fill another slot.
    const identical = !pick_id && playerPicks.find(pick => pick.slate_id === slate_id && pick.team === team)
    if (identical) existingPick=identical
    if (existingPick && existingPick.team !== team && expected_version !== existingPick.updated_at) {
      return NextResponse.json({ error: 'This pick changed or the edit is stale. Refresh and try again.' }, { status: 409 })
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

    // Re-submitting the same team is a no-op


    const { data: receipt, error: saveError } = await supabase.rpc('save_pick', {
      p_player_id:playerId,p_slate_id:slate_id,p_team:team,p_request_id:requestId,
      p_pick_id:existingPick?.id ?? null,p_expected:existingPick?.updated_at ?? null,
      p_admin_actor:isAdmin ? await adminSessionId() : null,p_reason:isAdmin ? reason ?? null : null,
    })
    if (saveError) {
      const expected=pickWriteError(saveError)
      if (expected) return NextResponse.json({error:expected.message},{status:expected.status})
      if (/stale|request id/i.test(saveError.message)) return NextResponse.json({error:'This pick changed. Refresh before editing.'},{status:409})
      if (/reason/i.test(saveError.message)) return NextResponse.json({error:'Administrator corrections require a reason.'},{status:400})
      throw saveError
    }
    revalidateContest()
    return NextResponse.json({ ok: true, ...receipt })
  } catch (err) {
    return serverError('api/picks', err)
  }
}

// Private reconciliation for a browser that lost the save response.
export async function GET(req: NextRequest) {
 const session=await getSession()
 if(!session) return NextResponse.json({error:'Not logged in'},{status:401})
 const requestId=req.nextUrl.searchParams.get('request_id')
 if(!requestId || !isUuid(requestId)) return NextResponse.json({error:'Invalid request ID'},{status:400})
 const db=await getDb()
 if(process.env.TOURNAMENT_RELIABILITY_ENABLED!=='true'){
  const slate=req.nextUrl.searchParams.get('slate_id'),team=req.nextUrl.searchParams.get('team')
  if(!slate||!isUuid(slate)||!team||team.length>80)return NextResponse.json({error:'Selection context required for legacy reconciliation'},{status:400})
  const {data,error}=await db.from('picks').select('id,team,slate_id,updated_at').eq('player_id',session.player_id).eq('slate_id',slate).eq('team',team).maybeSingle()
  if(error)return serverError('api/picks/reconcile',error)
  return NextResponse.json({found:!!data,pick:data},{headers:{'Cache-Control':'private, no-store'}})
 }
 const {data,error}=await db.from('pick_requests').select('receipt').eq('player_id',session.player_id).eq('request_id',requestId).maybeSingle()
 if(error) return serverError('api/picks/reconcile',error)
 return NextResponse.json({found:!!data,...data?.receipt},{headers:{'Cache-Control':'private, no-store'}})
}
