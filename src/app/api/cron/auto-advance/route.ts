import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireCronOrAdmin, isCronRequest } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'
import type { Game } from '@/types'

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
  const unauthorized = await requireCronOrAdmin(req)
  if (unauthorized) return unauthorized

  if (isCronRequest(req)) {
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

    const { data: currentGames } = await supabase
      .from('games')
      .select('tip_time, time_tbd')
      .eq('slate_id', slate.id)
    const slateGames = (currentGames || []) as Pick<Game, 'tip_time' | 'time_tbd'>[]

    // Announced tips only. A game whose time ESPN hasn't published carries a
    // midnight-Eastern placeholder, which is 11pm Central the night *before*
    // the day the game belongs to — treating that as "already tipped" would
    // advance off a slate before any of its games had been played.
    const tipsDescending = slateGames
      .filter((g) => !g.time_tbd)
      .map((g) => new Date(g.tip_time).getTime())
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => b - a)
    const now = await getEffectiveNow()

    if (tipsDescending.length > 0 && now.getTime() < tipsDescending[0]) {
      return NextResponse.json({ ok: true, message: `Slate ${slate.slate_number}'s games haven't all tipped off yet — nothing to advance` })
    }
    // Games on the board but not one announced time among them: the day hasn't
    // been played, it just hasn't been scheduled. Staying put is the safe
    // answer — the daily re-sync picks the real times up when ESPN posts them.
    if (tipsDescending.length === 0 && slateGames.length > 0) {
      return NextResponse.json({
        ok: true,
        message: `Slate ${slate.slate_number} has no announced tip times yet — nothing to advance`,
      })
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

    // Deactivate first, then activate: the one-active partial index rejects a
    // second active row, so the pair has to pass through an all-false state. If
    // the second half fails, put the old slate back — every `.eq('is_active',
    // true).single()` read in the app resolves to "no row" when nothing is
    // active, and the whole site renders as if the pool never started.
    await supabase.from('slates').update({ is_active: false }).eq('is_active', true)
    const { error: activateErr } = await supabase.from('slates').update({ is_active: true }).eq('id', result.slateId)
    if (activateErr) {
      await supabase.from('slates').update({ is_active: true }).eq('id', slate.id)
      return NextResponse.json({ ok: false, error: activateErr.message }, { status: 500 })
    }

    const label = nextDate
    await logAudit(supabase, {
      event_type: 'slate-advanced',
      actor: isCronRequest(req) ? 'system' : 'admin',
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
    console.error('auto-advance error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
