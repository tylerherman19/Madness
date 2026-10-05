import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import { getOrCreateSlate, renumberSlates, refreshLockTime, refreshLocksAfterMoves, storedSlatesOf } from '@/lib/slates'
import { gameDayOf } from '@/lib/gameDay'
import { fromZonedTime } from 'date-fns-tz'

const CHICAGO_TZ = 'America/Chicago'

interface ManualGame {
  date: string // YYYY-MM-DD, Central
  time: string // HH:MM, Central
  home_team: string
  away_team: string
}

// Manual entry for games ESPN doesn't carry (an exhibition, a feed outage, a
// fix-up). The ESPN sync is the normal path; this exists so a slate is never
// blocked on the feed.
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { season_year, games } = await req.json()
    if (!Number.isInteger(season_year) || !Array.isArray(games) || games.length === 0) {
      return NextResponse.json({ error: 'Missing season_year or games' }, { status: 400 })
    }

    const supabase = await getDb()

    // Games are grouped by the game day of their tip — a slate is a day, so
    // the form doesn't ask which slate a game belongs to. A game day runs
    // 6 AM to 6 AM Central (lib/gameDay.ts), so a game entered at 12:30 AM
    // joins the evening before rather than locking the next day at 12:30 AM.
    const byDate = new Map<string, { game: ManualGame; tip: string }[]>()
    for (const g of games as ManualGame[]) {
      if (!g.date || !g.time || !g.home_team || !g.away_team) {
        return NextResponse.json({ error: 'Every game needs a date, time, and both teams' }, { status: 400 })
      }
      if (g.home_team === g.away_team) {
        return NextResponse.json({ error: 'A team cannot play itself' }, { status: 400 })
      }
      // The form sends naive wall-clock strings meaning Central time;
      // converting here avoids depending on the server's own time zone.
      const time = /^\d{2}:\d{2}$/.test(g.time) ? `${g.time}:00` : g.time
      const tip = fromZonedTime(`${g.date}T${time}`, CHICAGO_TZ)
      if (isNaN(tip.getTime())) {
        return NextResponse.json({ error: `Invalid date or time for ${g.away_team} @ ${g.home_team}` }, { status: 400 })
      }
      const day = gameDayOf(tip.toISOString())
      const bucket = byDate.get(day)
      if (bucket) bucket.push({ game: g, tip: tip.toISOString() })
      else byDate.set(day, [{ game: g, tip: tip.toISOString() }])
    }

    const touched: string[] = []
    const eventIdOf = (g: ManualGame) => `manual:${g.date}:${g.away_team}@${g.home_team}`
    // Re-submitting a game with a new time can move it to another day.
    const previousSlate = await storedSlatesOf(supabase, (games as ManualGame[]).map(eventIdOf))
    const moves: { eventId: string; fromSlateId: string }[] = []

    for (const [date, dayGames] of byDate) {
      const slate = await getOrCreateSlate(supabase, date, season_year)
      if ('error' in slate) {
        return NextResponse.json({ error: slate.error }, { status: 500 })
      }

      const rows = dayGames.map(({ game: g, tip }) => {
        // `espn_event_id` is NOT NULL and unique — it's what makes the
        // per-conference syncs idempotent. Manual rows get a synthetic id in
        // the same namespace so they dedupe on re-submit and stay visibly
        // distinct from anything ESPN supplied.
        const eventId = eventIdOf(g)
        const storedOn = previousSlate.get(eventId)
        if (storedOn && storedOn !== slate.id) moves.push({ eventId, fromSlateId: storedOn })
        return {
          slate_id: slate.id,
          espn_event_id: eventId,
          home_team: g.home_team,
          away_team: g.away_team,
          tip_time: tip,
          status_state: 'pre' as const,
        }
      })

      // `result` is intentionally omitted: it takes the table default on
      // insert and is left untouched on conflict, so re-submitting the form
      // can never clobber an already-graded game.
      const { error: insertError } = await supabase
        .from('games')
        .upsert(rows, { onConflict: 'espn_event_id' })
      if (insertError) {
        return NextResponse.json({ error: `Failed to save games: ${insertError.message}` }, { status: 500 })
      }

      await refreshLockTime(supabase, slate.id)
      touched.push(date)
    }

    await refreshLocksAfterMoves(supabase, moves)
    await renumberSlates(supabase, season_year)

    return NextResponse.json({ ok: true, dates: touched, games_saved: games.length })
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

  // Deleting a game can change which tip is first, so the slate's cached
  // lock time has to be recomputed rather than left pointing at a game that
  // no longer exists.
  const { data: game } = await supabase.from('games').select('slate_id').eq('id', id).maybeSingle()

  const { error } = await supabase.from('games').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (game?.slate_id) await refreshLockTime(supabase, game.slate_id)

  return NextResponse.json({ ok: true })
}
