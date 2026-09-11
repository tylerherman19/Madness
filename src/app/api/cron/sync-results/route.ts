import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireCronOrAdmin } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { gradeSlatePicks } from '@/lib/grading'
import type { Game } from '@/types'

// Vercel Cron — refreshes the active slate from ESPN and grades picks, no
// admin needed. Re-syncing is how results arrive: syncSlateFromEspn writes
// scores, status and result for every game on the day, so this route no
// longer reimplements the ESPN-to-DB mapping.

// Grading awaits a paced elimination email per eliminated player.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const unauthorized = await requireCronOrAdmin(req)
  if (unauthorized) return unauthorized

  try {
    const supabase = await getDb()
    const { data: slate } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year')
      .eq('is_active', true)
      .single()

    if (!slate) return NextResponse.json({ ok: true, message: 'No active slate' })

    const yyyymmdd = String(slate.slate_date).replace(/-/g, '')
    const sync = await syncSlateFromEspn(supabase, yyyymmdd, slate.season_year)
    if (!sync.ok) {
      return NextResponse.json({ error: sync.error }, { status: 502 })
    }

    const { data: dbGames } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', slate.id)

    const completedGames = ((dbGames ?? []) as Game[]).filter((g) => g.result !== 'pending')
    if (completedGames.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No completed games to grade',
        games_synced: sync.gamesSynced,
      })
    }

    // Idempotent — re-grading games finished on an earlier run is a no-op.
    const grading = await gradeSlatePicks(supabase, slate.id, slate.slate_number, completedGames)

    return NextResponse.json({
      ok: true,
      games_synced: sync.gamesSynced,
      partial: sync.partial,
      grading,
    })
  } catch (err) {
    console.error('sync-results error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
