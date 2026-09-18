import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchDayScoreboard,
  eventCompetitors,
  parseRound,
  broadcastOf,
  resultOf,
  seedOf,
  centralDateOf,
  easternDateOf,
  isTimeTbd,
  CONFERENCES,
} from './espn'
import { getOrCreateSlate, renumberSlates, refreshLockTime } from './slates'

export interface SyncResult {
  ok: boolean
  error?: string
  slateId?: string
  gamesSynced?: number
  teamsSeen?: number
  // Conferences whose ESPN call failed. Games are still written, but stale
  // rows are left alone when this is non-empty — see below.
  partial?: string[]
}

// Games this app created itself rather than read from ESPN: hand-entered
// schedule rows and Test Mode's fabricated slate. Their ids live in their own
// namespaces so a sync can tell them apart from real ESPN events.
function isLocallyEntered(espnEventId: string): boolean {
  return espnEventId.startsWith('manual:') || espnEventId.startsWith('sandbox:')
}

// Sync one day's games from ESPN into `supabase` (the caller passes getDb()'s
// result so this routes to prod or the test sandbox correctly).
//
// `yyyymmdd` is the ESPN query date. Games are filed under the slate matching
// their own Central tip date, which is not always the queried one: ESPN's
// `dates` parameter returns late games that tip after midnight ET the
// following day, and those belong to the day they are actually played.
//
// Only activates a slate if nothing else is active — syncing tomorrow must
// not switch the active slate out from under today.
export async function syncSlateFromEspn(
  supabase: SupabaseClient,
  yyyymmdd: string,
  seasonYear: number
): Promise<SyncResult> {
  const { events, failedGroups } = await fetchDayScoreboard(yyyymmdd, 0)

  if (failedGroups.length === Object.keys(CONFERENCES).length + 1) {
    return { ok: false, error: 'ESPN unavailable — every conference request failed' }
  }
  if (events.length === 0) {
    const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    return { ok: false, error: `No games found for ${date} in the tracked conferences.` }
  }

  // Bucket events by the day they are actually played on. Normally that is
  // the Central date of the tip. For a game whose time ESPN hasn't announced
  // yet, the "tip" is a midnight-Eastern placeholder — 11pm Central the day
  // before — so its Eastern date is the real playing date.
  const byDate = new Map<string, typeof events>()
  for (const event of events) {
    const date = isTimeTbd(event) ? easternDateOf(event.date) : centralDateOf(event.date)
    const bucket = byDate.get(date)
    if (bucket) bucket.push(event)
    else byDate.set(date, [event])
  }

  const { data: currentActive } = await supabase
    .from('slates')
    .select('id')
    .eq('is_active', true)
    .maybeSingle()

  const teamRows = new Map<string, Record<string, unknown>>()
  let totalGames = 0
  let primarySlateId: string | undefined

  // The requested day is the one we report back and may activate; any spill
  // onto the next date is written too, but never steals `is_active`.
  const requestedDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`

  for (const [slateDate, dayEvents] of byDate) {
    const slate = await getOrCreateSlate(supabase, slateDate, seasonYear)
    if ('error' in slate) return { ok: false, error: slate.error }
    const slateId = slate.id
    if (slateDate === requestedDate) primarySlateId = slateId

    const rows = []

    for (const event of dayEvents) {
      const teams = eventCompetitors(event)
      if (!teams) continue
      const homeAbbr = teams.home.team.abbreviation
      const awayAbbr = teams.away.team.abbreviation
      if (!homeAbbr || !awayAbbr) continue

      for (const c of [teams.home, teams.away]) {
        const abbr = c.team.abbreviation
        if (abbr && !teamRows.has(abbr)) {
          teamRows.set(abbr, {
            abbr,
            display_name: c.team.displayName ?? abbr,
            short_name: c.team.shortDisplayName ?? null,
            logo: c.team.logo ?? null,
            updated_at: new Date().toISOString(),
          })
        }
      }

      const comp = event.competitions[0]
      const tbd = isTimeTbd(event)
      const { roundLabel, region } = parseRound(event)
      const state = comp.status?.type?.state
      const homeScore = teams.home.score != null ? Number(teams.home.score) : null
      const awayScore = teams.away.score != null ? Number(teams.away.score) : null

      rows.push({
        slate_id: slateId,
        espn_event_id: event.id,
        home_team: homeAbbr,
        away_team: awayAbbr,
        home_seed: seedOf(teams.home),
        away_seed: seedOf(teams.away),
        tip_time: event.date,
        time_tbd: tbd,
        round_label: roundLabel,
        region,
        venue: comp.venue?.fullName ?? null,
        tv: broadcastOf(event),
        status_state: state === 'in' || state === 'post' ? state : 'pre',
        period: comp.status?.period ?? null,
        display_clock: comp.status?.displayClock ?? null,
        home_score: Number.isNaN(homeScore) ? null : homeScore,
        away_score: Number.isNaN(awayScore) ? null : awayScore,
        result: resultOf(event),
      })
    }

    if (rows.length > 0) {
      // Conflict on the ESPN event id — the same game arriving from two
      // conference calls updates one row rather than inserting twice.
      const { error } = await supabase
        .from('games')
        .upsert(rows, { onConflict: 'espn_event_id' })
      if (error) {
        return { ok: false, error: `Failed to save games: ${error.message}` }
      }
      totalGames += rows.length
    }

    // Drop games ESPN no longer lists for this slate — but only when every
    // conference answered. After a partial fetch, a missing game means "we
    // didn't ask successfully", not "it was cancelled", and deleting it would
    // silently void the picks that reference it.
    //
    // Only ESPN-sourced rows are candidates. A `manual:` row exists precisely
    // because ESPN doesn't carry that game (see /api/schedule), and a
    // `sandbox:` row is fabricated for Test Mode — ESPN's silence about
    // either one says nothing, so sweeping them would delete the schedule the
    // admin entered by hand.
    if (failedGroups.length === 0) {
      const { data: stored } = await supabase
        .from('games')
        .select('id, espn_event_id')
        .eq('slate_id', slateId)
      const live = new Set(rows.map((r) => r.espn_event_id))
      const staleIds = (stored ?? [])
        .filter((g) => !live.has(g.espn_event_id) && !isLocallyEntered(g.espn_event_id))
        .map((g) => g.id)
      if (staleIds.length > 0) {
        await supabase.from('games').delete().in('id', staleIds)
      }
    }

    // Cache the day's first announced tip from the games that are now stored,
    // rather than from this fetch's rows. After a partial fetch those rows are
    // only part of the day: deriving the lock from them alone would move it
    // later than the real first tip — or null it out entirely — and leave
    // picks open after the games had started.
    await refreshLockTime(supabase, slateId)
  }

  await renumberSlates(supabase, seasonYear)

  if (teamRows.size > 0) {
    await supabase.from('teams').upsert([...teamRows.values()], { onConflict: 'abbr' })
  }

  if (!currentActive && primarySlateId) {
    await supabase.from('slates').update({ is_active: true }).eq('id', primarySlateId)
  }

  return {
    ok: true,
    slateId: primarySlateId,
    gamesSynced: totalGames,
    teamsSeen: teamRows.size,
    partial: failedGroups.length > 0 ? failedGroups : undefined,
  }
}
