import { NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'
import { gradeSlatePicks } from '@/lib/grading'
import { runAutoAssignNow } from '@/lib/autoAssign'
import { loadGamesForSlates } from '@/lib/seasonData'
import type { Game } from '@/types'
import { serverError } from '@/lib/alerts'
import { isAdvanceWindow } from '@/lib/advanceSchedule'
import { centralClock } from '@/lib/operationPolicy'

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
    if (!currentGames.length || currentGames.some(game => game.result === 'pending')) {
      return NextResponse.json({ ok: true, message: 'Awaiting all final results; current slate remains active' })
    }
    await gradeSlatePicks(supabase, slate.id, slate.slate_number, currentGames)
    const assignment = await runAutoAssignNow(supabase, now)
    if (!assignment.ok || !assignment.done) return NextResponse.json({ error: 'Assignments are incomplete; advancement deferred' }, { status: 409 })
    await gradeSlatePicks(supabase, slate.id, slate.slate_number, currentGames)

    if(process.env.TOURNAMENT_RELIABILITY_ENABLED==='true') {
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

    const { error: activateErr } = process.env.AUTOMATION_V2_ENABLED === 'true'
      ? await supabase.rpc('activate_slate_checked', { p_expected: slate.id, p_next: result.slateId })
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
