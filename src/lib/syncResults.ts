import { getPoolConfig } from '@/lib/pool'
import { revalidateContest } from '@/lib/revalidateContest'
import { NextResponse } from 'next/server'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { gradeSlatePicks } from '@/lib/grading'
import { loadGamesForSlates, loadPicksForSlates, loadAll } from '@/lib/seasonData'
import type { Slate } from '@/types'
import { serverError } from '@/lib/alerts'
import { orderRecoveryDates } from './operationPolicy'

export async function syncResults(supabase: import('@supabase/supabase-js').SupabaseClient, now: Date) {
  try {
    const pool = await getPoolConfig(supabase, true)
    const slates = (await loadAll<Slate>(supabase, 'slates', '*')).filter(day => !pool.starts_on || day.slate_date >= pool.starts_on)
    const active = slates.find(slate => slate.is_active)
    if (!active) return NextResponse.json({ ok: true, message: 'No active slate' })
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
    const pending = orderRecoveryDates(overdue.filter(slate => !slate.is_active && pickedIds.has(slate.id) &&
      storedGames.some(game => game.slate_id === slate.id && game.result === 'pending'))
      , process.env.AUTOMATION_V2_ENABLED === 'true')
    const candidates = [active, ...pending.slice(0, 3)]
    let failed = 0
    for (const slate of candidates) {
      try {
        const sync = await syncSlateFromEspn(supabase, slate.slate_date.replace(/-/g, ''), slate.season_year)
        if (!sync.ok || sync.partial?.length) throw new Error('Result feed is incomplete')
        const games = await loadGamesForSlates(supabase, [slate.id])
        grading.push({ slate_id: slate.id, ...await gradeSlatePicks(supabase, slate.id,
          slate.slate_number, games.filter(game => game.result !== 'pending')) })
      } catch { failed++ }
      if (process.env.AUTOMATION_V2_ENABLED === 'true') {
        const { error } = await supabase.from('slates').update({ result_checked_at: new Date().toISOString() }).eq('id', slate.id)
        if (error) throw error
      }
    }
    if (failed) throw new Error(`${failed} result dates could not be reconciled; other dates were processed`)
    revalidateContest()
    return NextResponse.json({ ok: true, periods_synced: candidates.length, grading })

  } catch (err) {
    return serverError('api/cron/sync-results', err)
  }
}
