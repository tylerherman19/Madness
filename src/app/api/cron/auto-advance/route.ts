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

// Vercel Cron (vercel.json) — fires daily. It never advances on the clock
// alone: the active slate's last tip has to have happened first, because the
// admin can sync a slate active days before it is played.
//
// Advancing means finding the next calendar day that has games and making it
// active, skipping dark days.
export async function GET(req: NextRequest) {
  const unauthorized = await requireCronOrAdmin(req)
  if (unauthorized) return unauthorized

  // The NFL version fired twice a day (17:00 and 18:00 UTC) so that one run
  // always landed on noon Central through the DST switch, and guarded itself
  // to the noon run because advancing is not idempotent. There is a single
  // daily run now, so that guard is gone — keeping it would have meant
  // advancing never happened at all, since 10:00 UTC is never noon Central.
  // Safety comes from the last-tip check below instead.

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
