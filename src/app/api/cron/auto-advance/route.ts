import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'
import { gradeSlatePicks } from '@/lib/grading'
import { runAutoAssignNow } from '@/lib/autoAssign'
import { loadGamesForSlates } from '@/lib/seasonData'
import type { Game } from '@/types'
import { serverError } from '@/lib/alerts'

// How far ahead to look for the next day that actually has games. College
// basketball has plenty of dark days mid-week, so advancing cannot just add
// one to a slate number the way the NFL version incremented a week.
const MAX_LOOKAHEAD_DAYS = 10
const ADVANCE_HOUR_CENTRAL = 6

// Vercel Cron fires at both possible UTC equivalents of 6:00 AM Central. The
// guard below accepts only the run that is actually 6:00 AM after DST is
// applied. It never advances on the clock alone: the active slate's last tip
// also has to have happened first.
//
// Advancing means finding the next calendar day that has games and making it
// active, skipping dark days.
export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  if (unauthorized) return unauthorized
  return run('system')
}

// Admin-triggered run (the admin UI). POST rather than GET so a cross-site
// link can't fire it with the admin's cookie — see requireCron.
export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  return run('admin')
}

async function run(actor: 'system' | 'admin') {
  // Only the scheduled run is held to the 6 AM window; an admin advancing by
  // hand is a deliberate override.
  if (actor === 'system') {
    const centralHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()))
    if (centralHour !== ADVANCE_HOUR_CENTRAL) {
      return NextResponse.json({ ok: true, message: 'Outside the 6:00 AM Central advance window' })
    }
  }

  try {
    const supabase = await getDb()
    const { data: slate, error: slateError } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year')
      .eq('is_active', true)
      .maybeSingle()

    if (slateError) throw slateError
    if (!slate) return NextResponse.json({ ok: true, message: 'No active slate' })

    const currentGames: Game[] = await loadGamesForSlates(supabase, [slate.id])
    if (!currentGames.length || currentGames.some(game => game.result === 'pending')) {
      return NextResponse.json({ ok: true, message: 'Awaiting all final results; current slate remains active' })
    }
    const assignment = await runAutoAssignNow(supabase, await getEffectiveNow())
    if (!assignment.ok || !assignment.done) return NextResponse.json({ error: 'Assignments are incomplete; advancement deferred' }, { status: 409 })
    await gradeSlatePicks(supabase, slate.id, slate.slate_number, currentGames)

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

    const { error: activateErr } = await supabase.rpc('activate_slate', { p_slate_id: result.slateId })
    if (activateErr) return serverError('api/cron/auto-advance', activateErr, 'Transactional activation unavailable; apply migration 022')

    const label = nextDate
    await logAudit(supabase, {
      event_type: 'slate-advanced',
      actor,
      message: `Pool advanced from ${slate.slate_date} to ${label} (${result.gamesSynced} games synced)`,
      details: { from_date: slate.slate_date, to_date: nextDate, games_synced: result.gamesSynced },
    })

    revalidatePath('/')
    return NextResponse.json({
      ok: true,
      advanced_to: label,
      games_synced: result.gamesSynced,
    })
  } catch (err) {
    return serverError('api/cron/auto-advance', err)
  }
}
