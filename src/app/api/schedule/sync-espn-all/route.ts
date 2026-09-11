import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'

// Each day is six ESPN calls (five conferences + the tournament) issued in
// parallel, then a handful of upserts. Thirty-odd days still fits, but the
// cap below keeps a typo from kicking off a months-long crawl.
export const maxDuration = 300

const MAX_DAYS = 45

function toDate(input: unknown): Date | null {
  if (typeof input !== 'string') return null
  const d = new Date(`${input}T12:00:00Z`)
  return isNaN(d.getTime()) ? null : d
}

function compact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

// Sync a range of days. Unlike the NFL version this does not stop at the
// first empty day: college basketball has plenty of dark Mondays mid-season,
// and stopping there would silently truncate the range.
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { season_year, start_date, end_date } = await req.json()
    const start = toDate(start_date)
    const end = toDate(end_date)
    if (!Number.isInteger(season_year) || !start || !end) {
      return NextResponse.json(
        { error: 'Need season_year, start_date and end_date (YYYY-MM-DD)' },
        { status: 400 }
      )
    }
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
    if (days < 1 || days > MAX_DAYS) {
      return NextResponse.json(
        { error: `Range must be between 1 and ${MAX_DAYS} days` },
        { status: 400 }
      )
    }

    const supabase = await getDb()
    const synced: { date: string; games: number }[] = []
    const empty: string[] = []
    const failures: { date: string; error?: string }[] = []

    for (let i = 0; i < days; i++) {
      const day = new Date(start.getTime() + i * 86_400_000)
      const yyyymmdd = compact(day)
      const result = await syncSlateFromEspn(supabase, yyyymmdd, season_year)
      if (result.ok) {
        synced.push({ date: yyyymmdd, games: result.gamesSynced ?? 0 })
      } else if (result.error?.startsWith('No games found')) {
        empty.push(yyyymmdd)
      } else {
        failures.push({ date: yyyymmdd, error: result.error })
      }
    }

    const totalGames = synced.reduce((sum, s) => sum + s.games, 0)
    await logAudit(supabase, {
      event_type: 'schedule-synced',
      actor: 'admin',
      message: `Admin bulk-synced ${synced.length} day${synced.length === 1 ? '' : 's'} from ESPN (${totalGames} games)${failures.length > 0 ? `, ${failures.length} failed` : ''}`,
      details: { season_year, start_date, end_date, total_games: totalGames, empty_days: empty.length, failures },
    })

    return NextResponse.json({
      ok: failures.length === 0,
      days_synced: synced.map((s) => s.date),
      total_games: totalGames,
      empty_days: empty,
      failures: failures.length > 0 ? failures : undefined,
    })
  } catch (err) {
    console.error('sync-espn-all error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
