import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid, readJsonObject, badRequest, serverError } from '@/lib/api'
import { isClockTime, isIsoDate, isTeamCode } from '@/lib/validation'
import { getOrCreateSlate, renumberSlates, refreshLockTime } from '@/lib/slates'
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
    const body = await readJsonObject(req)
    if (!body) return badRequest()
    const { season_year, games } = body
    if (!Number.isInteger(season_year) || (season_year as number) < 2000 || (season_year as number) > 2100 || !Array.isArray(games) || games.length === 0) {
      return NextResponse.json({ error: 'Missing season_year or games' }, { status: 400 })
    }
    if (games.length > 200) return badRequest('Too many games in one request (max 200)')

    const supabase = await getDb()

    // Games are grouped by their own Central date — a slate is a day, so the
    // form no longer asks which slate a game belongs to.
    const byDate = new Map<string, ManualGame[]>()
    for (const g of games as ManualGame[]) {
      if (!g || typeof g !== 'object' || !g.date || !g.time || !g.home_team || !g.away_team) {
        return NextResponse.json({ error: 'Every game needs a date, time, and both teams' }, { status: 400 })
      }
      if (!isIsoDate(g.date)) return badRequest(`${g.date} is not a real date (YYYY-MM-DD)`)
      if (!isClockTime(g.time)) return badRequest(`${g.time} is not a valid time (HH:MM, 24-hour)`)
      if (!isTeamCode(g.home_team) || !isTeamCode(g.away_team)) {
        return badRequest('Team codes must be 1–12 letters, digits, &, ., \' or -')
      }
      g.home_team = g.home_team.trim().toUpperCase()
      g.away_team = g.away_team.trim().toUpperCase()
      if (g.home_team === g.away_team) {
        return NextResponse.json({ error: 'A team cannot play itself' }, { status: 400 })
      }
      const bucket = byDate.get(g.date)
      if (bucket) bucket.push(g)
      else byDate.set(g.date, [g])
    }

    const touched: string[] = []

    for (const [date, dayGames] of byDate) {
      const slate = await getOrCreateSlate(supabase, date, season_year as number)
      if ('error' in slate) {
        return serverError('schedule slate error', slate.error, `Could not create the ${date} game day`)
      }

      const rows = dayGames.map((g) => ({
        slate_id: slate.id,
        // `espn_event_id` is NOT NULL and unique — it's what makes the
        // per-conference syncs idempotent. Manual rows get a synthetic id in
        // the same namespace so they dedupe on re-submit and stay visibly
        // distinct from anything ESPN supplied.
        espn_event_id: `manual:${date}:${g.away_team}@${g.home_team}`,
        home_team: g.home_team,
        away_team: g.away_team,
        // The form sends naive wall-clock strings meaning Central time;
        // converting here avoids depending on the server's own time zone.
        tip_time: fromZonedTime(`${g.date}T${g.time}:00`, CHICAGO_TZ).toISOString(),
        status_state: 'pre' as const,
      }))

      // `result` is intentionally omitted: it takes the table default on
      // insert and is left untouched on conflict, so re-submitting the form
      // can never clobber an already-graded game.
      const { error: insertError } = await supabase
        .from('games')
        .upsert(rows, { onConflict: 'espn_event_id' })
      if (insertError) {
        return serverError('schedule upsert error', insertError, `Failed to save games for ${date}`)
      }

      await refreshLockTime(supabase, slate.id)
      touched.push(date)
    }

    await renumberSlates(supabase, season_year as number)

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
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const supabase = await getDb()

  // Deleting a game can change which tip is first, so the slate's cached
  // lock time has to be recomputed rather than left pointing at a game that
  // no longer exists.
  const { data: game } = await supabase.from('games').select('slate_id').eq('id', id).maybeSingle()

  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  const { error } = await supabase.from('games').delete().eq('id', id)
  if (error) return serverError('schedule delete error', error, 'Failed to delete game')

  if (game?.slate_id) await refreshLockTime(supabase, game.slate_id)

  return NextResponse.json({ ok: true })
}
