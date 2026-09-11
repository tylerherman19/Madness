import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import { fromZonedTime } from 'date-fns-tz'

const CHICAGO_TZ = 'America/Chicago'

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { slate_number, season_year, games } = await req.json()
    if (!Number.isInteger(slate_number) || !Number.isInteger(season_year) || !Array.isArray(games)) {
      return NextResponse.json({ error: 'Missing slate_number, season_year, or games' }, { status: 400 })
    }

    const supabase = await getDb()

    // Find or create the slate
    const { data: existingWeek } = await supabase
      .from('slates')
      .select('id')
      .eq('slate_number', slate_number)
      .eq('season_year', season_year)
      .single()

    const { data: currentActive } = await supabase
      .from('slates')
      .select('id')
      .eq('is_active', true)
      .maybeSingle()

    let slateId: string
    if (existingWeek) {
      slateId = existingWeek.id
    } else {
      // Only activate on creation if nothing else is active yet (first-time
      // setup). Otherwise the new slate starts inactive — building next slate's
      // slate in advance must not switch the active slate out from under the
      // current one. Explicit switches go through /api/admin/set-active-slate.
      const { data: newWeek, error } = await supabase
        .from('slates')
        .insert({ slate_number, season_year, is_active: !currentActive })
        .select('id')
        .single()

      if (error || !newWeek) {
        return NextResponse.json({ error: 'Failed to create slate' }, { status: 500 })
      }
      slateId = newWeek.id
    }

    if (!currentActive || currentActive.id === slateId) {
      await supabase.from('slates').update({ is_active: true }).eq('id', slateId)
    }

    // The form sends naive wall-clock strings ("2026-09-13T12:00:00") meaning
    // Central time — passing the string straight to fromZonedTime converts it
    // without depending on the server's own time zone.
    const rows = games.map((g: {
      home_team: string
      away_team: string
      game_day: string
      tip_time: string
      is_snf?: boolean
      is_mnf?: boolean
    }) => ({
      slate_id: slateId,
      home_team: g.home_team,
      away_team: g.away_team,
      game_day: g.game_day,
      tip_time: fromZonedTime(g.tip_time, CHICAGO_TZ).toISOString(),
      is_snf: g.is_snf || false,
      is_mnf: g.is_mnf || false,
    }))

    if (rows.length > 0) {
      // Upsert on (slate_id, home_team, away_team) so resubmitting the form
      // updates the existing matchup instead of duplicating it. `result` is
      // intentionally omitted: it takes the table default on insert, and is
      // left untouched on conflict so this can't clobber an already-graded score.
      const { error: insertError } = await supabase
        .from('games')
        .upsert(rows, { onConflict: 'slate_id,home_team,away_team' })
      if (insertError) {
        return NextResponse.json({ error: `Failed to save games: ${insertError.message}` }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true, slate_id: slateId })
  } catch (err) {
    console.error('schedule error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const supabase = await getDb()
  const { error } = await supabase.from('games').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
