import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from './db'

// Slate bookkeeping shared by the ESPN sync and the manual schedule form.
// Both create days on demand and both have to leave the season's numbering
// in calendar order afterwards.

// Find the slate for a Central calendar date, creating it if needed.
// A new slate only becomes active when nothing else is — building tomorrow
// must never switch today out from under the pool.
export async function getOrCreateSlate(
  db: SupabaseClient,
  slateDate: string,
  seasonYear: number
): Promise<{ id: string } | { error: string }> {
  const { data: existing } = await db
    .from('slates')
    .select('id')
    .eq('slate_date', slateDate)
    .eq('season_year', seasonYear)
    .maybeSingle()

  if (existing) return { id: existing.id }

  const { data: currentActive } = await db
    .from('slates')
    .select('id')
    .eq('is_active', true)
    .maybeSingle()

  const { data: created, error } = await db
    .from('slates')
    // Provisional number; renumberSlates puts the season back in date order.
    .insert({
      slate_number: 0,
      slate_date: slateDate,
      season_year: seasonYear,
      is_active: !currentActive,
    })
    .select('id')
    .single()

  if (error?.code === '23505') {
    // Another request created the same day between our read and insert —
    // (slate_date, season_year) is unique, so use the row that won. If the
    // clash was on the one-active index instead, retry as an inactive day.
    const { data: winner } = await db
      .from('slates')
      .select('id')
      .eq('slate_date', slateDate)
      .eq('season_year', seasonYear)
      .maybeSingle()
    if (winner) return { id: winner.id }
    const { data: inactive, error: retryError } = await db
      .from('slates')
      .insert({ slate_number: 0, slate_date: slateDate, season_year: seasonYear, is_active: false })
      .select('id')
      .single()
    if (inactive) return { id: inactive.id }
    return { error: `Failed to create slate ${slateDate}: ${retryError?.message}` }
  }

  if (error || !created) {
    return { error: `Failed to create slate ${slateDate}: ${error?.message}` }
  }
  return { id: created.id }
}

// `slate_number` is the human-facing "Day N" label, so it has to follow the
// calendar rather than insertion order — an admin who backfills last Tuesday
// after syncing today must not end up with Day 2 before Day 1. Cheap enough
// to redo wholesale: a season is a few hundred rows at most, and only the
// rows whose number actually moved are written.
export async function renumberSlates(
  db: SupabaseClient,
  seasonYear: number
): Promise<void> {
  const { data: slates } = await db
    .from('slates')
    .select('id, slate_number, slate_date')
    .eq('season_year', seasonYear)
    .order('slate_date', { ascending: true })

  if (!slates) return

  for (let i = 0; i < slates.length; i++) {
    const want = i + 1
    if (slates[i].slate_number === want) continue
    await db.from('slates').update({ slate_number: want }).eq('id', slates[i].id)
  }
}

// Cache the day's first tip on the slate so the pick page and the crons don't
// each re-derive it from the games.
export async function refreshLockTime(db: SupabaseClient, slateId: string): Promise<void> {
  // Announced tips only — a placeholder time would lock the slate at 11pm
  // the previous night. Null when nothing on the day has a time yet.
  const { data } = await db
    .from('games')
    .select('tip_time')
    .eq('slate_id', slateId)
    .eq('time_tbd', false)
    .order('tip_time', { ascending: true })
    .limit(1)

  await db
    .from('slates')
    .update({ locks_at: data?.[0]?.tip_time ?? null })
    .eq('id', slateId)
}

// Which day each game is stored under right now (espn_event_id -> slate_id).
// Best effort: it only feeds refreshLocksAfterMoves, and a sync shouldn't
// fail because this lookup did.
export async function storedSlatesOf(db: SupabaseClient, eventIds: string[]): Promise<Map<string, string>> {
  const stored = new Map<string, string>()
  for (const batch of chunk([...new Set(eventIds)])) {
    const { data, error } = await db.from('games').select('espn_event_id, slate_id').in('espn_event_id', batch)
    if (error) {
      console.error('Could not look up stored game days:', error.message)
      continue
    }
    for (const row of data ?? []) stored.set(row.espn_event_id, row.slate_id)
  }
  return stored
}

// After games have moved to another day, recompute the cached lock on each
// day they left — it may still point at a tip that is no longer there.
// A pick stays filed under the day it was made on, so a pick on a game that
// moved can no longer be graded automatically: flag it for the administrator.
export async function refreshLocksAfterMoves(
  db: SupabaseClient,
  moves: { eventId: string; fromSlateId: string }[]
): Promise<void> {
  if (moves.length === 0) return
  const fromSlateIds = [...new Set(moves.map((move) => move.fromSlateId))]
  for (const slateId of fromSlateIds) await refreshLockTime(db, slateId)

  const [{ data: games }, { data: picks }] = await Promise.all([
    db.from('games').select('espn_event_id, home_team, away_team').in('espn_event_id', moves.map((move) => move.eventId)),
    db.from('picks').select('slate_id, team').in('slate_id', fromSlateIds),
  ])
  for (const move of moves) {
    const game = (games ?? []).find((row) => row.espn_event_id === move.eventId)
    if (!game) continue
    const stranded = (picks ?? []).filter(
      (pick) => pick.slate_id === move.fromSlateId && (pick.team === game.home_team || pick.team === game.away_team)
    )
    if (stranded.length > 0) {
      console.warn(
        `${game.away_team}@${game.home_team} (${move.eventId}) moved to another game day, but ${stranded.length} pick(s) on it are still filed under slate ${move.fromSlateId} — grade them by hand`
      )
    }
  }
}
