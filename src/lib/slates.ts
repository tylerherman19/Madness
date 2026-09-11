import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

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
