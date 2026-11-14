import { NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'
import { gradeSlatePicks } from '@/lib/grading'
import { runAutoAssignNow } from '@/lib/autoAssign'
import { loadGamesForSlates, loadPicksForSlates } from '@/lib/seasonData'
import type { Game } from '@/types'
import { serverError } from '@/lib/alerts'
import { randomUUID } from 'node:crypto'
import { isAdvanceWindow } from '@/lib/advanceSchedule'
import { centralClock } from '@/lib/operationPolicy'
import { getPoolConfig } from '@/lib/pool'

const MAX_LOOKAHEAD_DAYS = 10
export async function advanceSlate(supabase: import('@supabase/supabase-js').SupabaseClient, now: Date, actor: 'system' | 'admin') {
  // Scheduled turnover starts at 3 AM; an admin advancing by
  // hand is a deliberate override.
  if (actor === 'system') {
    if (!isAdvanceWindow(now)) {
      return NextResponse.json({ ok: true, message: 'Before the 3:00 AM Central turnover' })
    }
  }

  try {
    const { data: slate, error: slateError } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year')
      .eq('is_active', true)
      .maybeSingle()

    if (slateError) throw slateError
    if (!slate) return NextResponse.json({ ok: true, caught_up: true, message: 'No active slate' })
    if (actor === 'system' && slate.slate_date >= centralClock(now).date) {
      return NextResponse.json({ ok: true, caught_up: true, message: 'Current playing day has not reached its overnight turnover' })
    }

    const refreshed = await syncSlateFromEspn(supabase, slate.slate_date.replace(/-/g, ''), slate.season_year)
    if (!refreshed.ok || refreshed.partial?.length) throw new Error('Cannot advance while the result feed is incomplete')
    const currentGames: Game[] = await loadGamesForSlates(supabase, [slate.id])
    const held = new Set(refreshed.reviewGames)
    // Grade clean games even if another game is waiting for organizer review.
    const finals = currentGames.filter(game => !held.has(game.id) && game.result !== 'pending')
    await gradeSlatePicks(supabase, slate.id, slate.slate_number, finals)
    // With every entry out after the contest started: a March Madness bracket stops here (a normal
    // resting state, not an error; restoring an entry lets the next run continue). A regular-season
    // pool has nothing to grade or assign, but its calendar keeps moving so the site is never stranded
    // on an old day. Only a positively identified regular-season pool keeps going.
    let nobodyAlive = false
    if (actor === 'system') {
      const { data: contest } = await supabase.rpc('contest_state')
      if ((contest as { stopped?: boolean } | null)?.stopped === true) {
        const pool = await getPoolConfig(supabase, true)
        if (pool.competition_mode !== 'regular-season') {
          return NextResponse.json({ ok: true, stopped: true, message: 'Stopped: no entries alive' })
        }
        nobodyAlive = true
      }
    }
    const complete = currentGames.length > 0 && finals.length === currentGames.length
    if (!complete) {
      const picks = await loadPicksForSlates<{team: string; loss_excused: boolean}>(supabase, [slate.id], 'team, loss_excused')
      const resolvedTeams = new Set(finals.flatMap(game => [game.home_team, game.away_team]))
      const allUnresolvedHeld = currentGames.length > 0 && currentGames.every(game =>
        held.has(game.id) || game.result !== 'pending')
      if (!allUnresolvedHeld || picks.some(pick => !pick.loss_excused && !resolvedTeams.has(pick.team))) {
        return NextResponse.json({ ok: true, waiting: true, message: 'Awaiting results or organizer review; current pick day remains active' })
      }
      const {data: state, error} = await supabase.from('slates').select('auto_assign_completed_at').eq('id', slate.id).single()
      if (error) throw error
      if (!state.auto_assign_completed_at) return NextResponse.json({ ok: true, waiting: true, message: 'Organizer review needed before assigning from an uncertain schedule' })
    }
    const assignment = await runAutoAssignNow(supabase, now)
    if (!assignment.ok || !assignment.done) return NextResponse.json({ error: 'Assignments are incomplete; advancement deferred' }, { status: 409 })
    await gradeSlatePicks(supabase, slate.id, slate.slate_number, finals)

    if(complete && process.env.TOURNAMENT_RELIABILITY_ENABLED==='true') {
      const {data:completed,error}=await supabase.rpc('complete_tournament',{p_slate:slate.id})
      if(error)throw error
      if(completed){revalidateContest();return NextResponse.json({ok:true,caught_up:true,completed:true})}
    }

    // Walk forward day by day until one has games. Each probe is a real sync,
    // so the day that wins is already populated when it goes active.
    const from = new Date(`${slate.slate_date}T12:00:00Z`)
    let result: Awaited<ReturnType<typeof syncSlateFromEspn>> | null = null
    let nextDate: string | null = null
    for (let i = 1; i <= MAX_LOOKAHEAD_DAYS; i++) {
      const day = new Date(from.getTime() + i * 86_400_000)
      const yyyymmdd = day.toISOString().slice(0, 10).replace(/-/g, '')
      const attempt = await syncSlateFromEspn(supabase, yyyymmdd, slate.season_year)
      if (attempt.partial?.length || (!attempt.ok && !attempt.error?.startsWith('No games found'))) throw new Error(attempt.error ?? 'Schedule is incomplete')
      if (attempt.ok && !attempt.partial?.length && attempt.slateId && (attempt.gamesSynced ?? 0) > 0) {
        result = attempt
        nextDate = day.toISOString().slice(0, 10)
        break
      }
    }

    if (!result || !result.slateId || !nextDate) {
      return NextResponse.json({
        ok: true,
        message: `No games found in the next ${MAX_LOOKAHEAD_DAYS} days — staying on Slate ${slate.slate_number}`,
      })
    }

    if (result.reviewGames?.length) return NextResponse.json({ ok: true, waiting: true, message: 'The next pick day needs schedule review' })
    if (actor === 'system' && !nobodyAlive && process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true') {
      const {data: next, error} = await supabase.from('slates').select('locks_at').eq('id', result.slateId).single()
      if (error) throw error
      if (!next.locks_at || new Date(next.locks_at) <= now) {
        const {error: incidentError} = await supabase.rpc('record_incident', {
          p_key: `turnover-missed:${nextDate}`, p_impact: 'A pick deadline passed before the day opened. Review missed days before resuming picks.',
          p_correlation: randomUUID(), p_detail: JSON.stringify({ from_date: slate.slate_date, missed_date: nextDate }),
        })
        if (incidentError) throw incidentError
        return NextResponse.json({ ok: true, waiting: true, message: 'A missed pick deadline requires organizer review' })
      }
    }

    const { error: activateErr } = process.env.AUTOMATION_V2_ENABLED === 'true'
      ? (process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true'
        ? await supabase.rpc('activate_ready_slate', { p_expected: slate.id, p_next: result.slateId, p_held: [...held], p_require_open: actor === 'system' && !nobodyAlive })
        : await supabase.rpc('activate_slate_checked', { p_expected: slate.id, p_next: result.slateId }))
      : await supabase.rpc('activate_slate', { p_slate_id: result.slateId })
    if (activateErr) return serverError('api/cron/auto-advance', activateErr, 'Transactional activation unavailable; apply migration 022')

    const label = nextDate
    await logAudit(supabase, {
      event_type: 'slate-advanced',
      actor,
      message: `Pool advanced from ${slate.slate_date} to ${label} (${result.gamesSynced} games synced)`,
      details: { from_date: slate.slate_date, to_date: nextDate, games_synced: result.gamesSynced },
    })

    revalidateContest()
    return NextResponse.json({
      ok: true,
      advanced_to: label,
      games_synced: result.gamesSynced,
    })
  } catch (err) {
    return serverError('api/cron/auto-advance', err)
  }
}
