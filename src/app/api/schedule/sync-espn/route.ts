import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import { syncSlateFromEspn } from '@/lib/espnSync'
import { logAudit } from '@/lib/audit'

// Accepts either YYYY-MM-DD or the bare YYYYMMDD that ESPN itself uses.
function normalizeDate(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const compact = input.replace(/-/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { date, season_year } = await req.json()
    const yyyymmdd = normalizeDate(date)
    if (!yyyymmdd || !Number.isInteger(season_year)) {
      return NextResponse.json(
        { error: 'Need a date (YYYY-MM-DD) and season_year' },
        { status: 400 }
      )
    }

    const supabase = await getDb()
    const result = await syncSlateFromEspn(supabase, yyyymmdd, season_year)

    if (!result.ok) {
      const status = result.error?.startsWith('No games found')
        ? 404
        : result.error?.startsWith('ESPN unavailable')
          ? 502
          : 500
      return NextResponse.json({ error: result.error }, { status })
    }

    await logAudit(supabase, {
      event_type: 'schedule-synced',
      actor: 'admin',
      message: `Admin synced ${date} from ESPN (${result.gamesSynced} games, ${result.teamsSeen} teams)`,
      details: { date, season_year, games_synced: result.gamesSynced, partial: result.partial },
    })

    return NextResponse.json({
      ok: true,
      slate_id: result.slateId,
      games_synced: result.gamesSynced,
      teams_seen: result.teamsSeen,
      partial: result.partial,
    })
  } catch (err) {
    console.error('sync-espn error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
