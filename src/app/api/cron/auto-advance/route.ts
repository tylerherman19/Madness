import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb, getEffectiveNow, isTestMode } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { settleOutstandingSlates, type SettleReport } from '@/lib/settle'
import { logAudit } from '@/lib/audit'
import type { Game } from '@/types'

// Up to ten day-probes against ESPN, plus grading the outgoing day first.
export const maxDuration = 300

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
    const { data: slate } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year')
      .eq('is_active', true)
      .single()

    if (!slate) return NextResponse.json({ ok: true, message: 'No active slate' })

    const { data: currentGames } = await supabase.from('games').select('tip_time').eq('slate_id', slate.id)
    const lastTip = ((currentGames || []) as Pick<Game, 'tip_time'>[])
      .map((g) => new Date(g.tip_time).getTime())
      .sort((a, b) => b - a)[0]
    const now = await getEffectiveNow()
    if (lastTip && now.getTime() < lastTip) {
      return NextResponse.json({ ok: true, message: `Slate ${slate.slate_number}'s games haven't all tipped off yet — nothing to advance` })
    }

    // Grade before moving on. The 3 AM results run has normally done this
    // already; this is its second chance — a late final, or a night ESPN was
    // down — and the catch-up for any earlier day still open. Moving on
    // without it would let the day's losers pick again tomorrow. A failure
    // here doesn't block the advance: the next results run retries.
    let graded: SettleReport | null = null
    try {
      graded = await settleOutstandingSlates(supabase, { syncEarlierDays: !(await isTestMode()) })
    } catch (err) {
      console.error('pre-advance grading failed', err)
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
      if (attempt.ok && attempt.slateId && (attempt.gamesSynced ?? 0) > 0) {
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

    await supabase.from('slates').update({ is_active: false }).eq('is_active', true)
    const { error: activateErr } = await supabase.from('slates').update({ is_active: true }).eq('id', result.slateId)
    if (activateErr) return NextResponse.json({ ok: false, error: activateErr.message }, { status: 500 })

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
      graded: graded?.outcomes.map((outcome) => ({
        date: outcome.slate_date,
        eliminated: outcome.grading?.eliminated.length ?? 0,
        settled: outcome.settled,
        error: outcome.error ?? outcome.sync_error,
      })),
    })
  } catch (err) {
    console.error('auto-advance error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
