import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { gradeSlatePicks } from '@/lib/grading'
import { loadGamesForSlates, loadPicksForSlates, loadAll } from '@/lib/seasonData'
import type { Slate } from '@/types'
import { serverError } from '@/lib/alerts'

// Vercel Cron — refreshes the active slate from ESPN and grades picks, no
// admin needed. Re-syncing is how results arrive: syncSlateFromEspn writes
// scores, status and result for every game on the day, so this route no
// longer reimplements the ESPN-to-DB mapping.

// Grading awaits a paced elimination email per eliminated player.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  if (unauthorized) return unauthorized
  return run()
}

// Admin-triggered run (the admin UI). POST rather than GET so a cross-site
// link can't fire it with the admin's cookie — see requireCron.
export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  return run()
}

async function run() {
  try {
    const supabase = await getDb()
    const slates = await loadAll<Slate>(supabase, 'slates', '*')
    const active = slates.find(slate => slate.is_active)
    if (!active) return NextResponse.json({ ok: true, message: 'No active slate' })
    const now = await getEffectiveNow()
    const overdue = slates.filter(slate => slate.season_year === active.season_year &&
      (slate.is_active || (slate.locks_at && new Date(slate.locks_at) <= now)))
    const ids = overdue.map(slate => slate.id)
    const [storedGames, picks] = await Promise.all([
      loadGamesForSlates(supabase, ids),
      loadPicksForSlates<{ slate_id: string }>(supabase, ids, 'slate_id'),
    ])
    const pickedIds = new Set(picks.map(pick => pick.slate_id))
    // Reconcile stored finals on every overdue period, including days left
    // behind by an interrupted cron. Notifications cannot delay scoring.
    const grading = []
    for (const slate of overdue) {
      if (!pickedIds.has(slate.id)) continue
      grading.push({ slate_id: slate.id, ...await gradeSlatePicks(supabase, slate.id,
        slate.slate_number, storedGames.filter(game => game.slate_id === slate.id && game.result !== 'pending')) })
    }
    // Bound provider work. Old unfinished dates remain candidates on every
    // invocation until their results arrive; never depend solely on active day.
    const pending = overdue.filter(slate => !slate.is_active && pickedIds.has(slate.id) &&
      storedGames.some(game => game.slate_id === slate.id && game.result === 'pending'))
      .sort((a, b) => a.slate_date.localeCompare(b.slate_date))
    const candidates = [active, ...pending.slice(0, 3)]
    for (const slate of candidates) {
      const sync = await syncSlateFromEspn(supabase, slate.slate_date.replace(/-/g, ''), slate.season_year)
      if (!sync.ok || sync.partial?.length) throw new Error(sync.error ?? 'Result feed is incomplete')
      const games = await loadGamesForSlates(supabase, [slate.id])
      grading.push({ slate_id: slate.id, ...await gradeSlatePicks(supabase, slate.id,
        slate.slate_number, games.filter(game => game.result !== 'pending')) })
    }
    return NextResponse.json({ ok: true, periods_synced: candidates.length, grading })

  } catch (err) {
    return serverError('api/cron/sync-results', err)
  }
}
