import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchDayScoreboard,
  eventCompetitors,
  parseRound,
  broadcastOf,
  resultOf,
  seedOf,
  easternDateOf,
  isTimeTbd,
  CONFERENCES,
} from './espn'
import { gameDayOf } from './gameDay'
import { getOrCreateSlate, refreshLocksAfterMoves, refreshLockTime, renumberSlates, storedSlatesOf } from './slates'

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

// Sync one day's games from ESPN into `supabase` (the caller passes getDb()'s
// result so this routes to prod or the test sandbox correctly).
//
// `yyyymmdd` is the ESPN query date. Games are filed under the game day of
// their own tip (lib/gameDay.ts: 6 AM to 6 AM Central), which is not always
// the queried one — a tip after midnight still belongs to the evening it is
// played in, and a game ESPN lists under a neighbouring date goes to its own
// day.
//
// Only activates a slate if nothing else is active — syncing tomorrow must
// not switch the active slate out from under today.
//
// `revalidateSeconds` lets callers on a hot path (the pick page) share one
// cached ESPN response across every request instead of each hitting ESPN.
// Crons and admin syncs leave it at 0 so they always read the live feed.
export async function syncSlateFromEspn(
  supabase: SupabaseClient,
  yyyymmdd: string,
  seasonYear: number,
  { revalidateSeconds = 0 }: { revalidateSeconds?: number } = {}
): Promise<SyncResult> {
  const { events, failedGroups } = await fetchDayScoreboard(yyyymmdd, revalidateSeconds)

  if (failedGroups.length === Object.keys(CONFERENCES).length + 1) {
    return { ok: false, error: 'ESPN unavailable — every conference request failed' }
  }
  if (events.length === 0) {
    const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    return { ok: false, error: `No games found for ${date} in the tracked conferences.` }
  }

  // Bucket events by the game day they are actually played on: the tip's
  // game day, which runs 6 AM to 6 AM Central. For a game whose time ESPN
  // hasn't announced yet, the "tip" is a midnight-Eastern placeholder — 11pm
  // Central the day before — so its Eastern date is the real playing date.
  const byDate = new Map<string, typeof events>()
  for (const event of events) {
    const date = isTimeTbd(event) ? easternDateOf(event.date) : gameDayOf(event.date)
    const bucket = byDate.get(date)
    if (bucket) bucket.push(event)
    else byDate.set(date, [event])
  }

  const { data: currentActive } = await supabase
    .from('slates')
    .select('id')
    .eq('is_active', true)
    .maybeSingle()

  // Which day each of these games is stored under now, so a game that moves
  // to another day (a tip time changed across the 6 AM boundary, or a row
  // filed under the old calendar-date rule) doesn't leave its old day locked
  // at a tip that is no longer on it.
  const previousSlate = await storedSlatesOf(supabase, events.map((event) => event.id))
  const moves: { eventId: string; fromSlateId: string }[] = []

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

      const storedOn = previousSlate.get(event.id)
      if (storedOn && storedOn !== slateId) moves.push({ eventId: event.id, fromSlateId: storedOn })

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

    // Only the requested day is authoritative. A bucket for any other date
    // holds just the stray games this query happened to return (a late tip
    // that spills past midnight), not that day's full schedule — pruning it
    // would delete every other game on that day.
    if (slateDate === requestedDate && failedGroups.length === 0) {
      await pruneMissingGames(supabase, slateId, new Set(rows.map((r) => r.espn_event_id)))
    }

    // Recompute the lock from everything stored on the slate — manual games
    // included, placeholder tips excluded — rather than from this query's
    // rows, which for a spill-over bucket are a single late game.
    await refreshLockTime(supabase, slateId)
  }

  await refreshLocksAfterMoves(supabase, moves)
  await renumberSlates(supabase, seasonYear)

  if (teamRows.size > 0) {
    await supabase.from('teams').upsert([...teamRows.values()], { onConflict: 'abbr' })
  }

  if (!currentActive && primarySlateId) {
    await supabase.from('slates').update({ is_active: true }).eq('id', primarySlateId)
  }

  if (primarySlateId) {
    // Freshness marker read by the pick window so page views reuse a recent
    // sync instead of re-syncing. Best effort: the column arrives with
    // migration 021 and the sync must still succeed without it.
    await supabase.from('slates').update({ synced_at: new Date().toISOString() }).eq('id', primarySlateId)
  }

  return {
    ok: true,
    slateId: primarySlateId,
    gamesSynced: totalGames,
    teamsSeen: teamRows.size,
    partial: failedGroups.length > 0 ? failedGroups : undefined,
  }
}

// Drop games ESPN no longer lists for a day it fully answered for. Two kinds
// of row are never touched:
//
//   * Rows ESPN never supplied (`manual:` from the admin schedule form,
//     `sandbox:` from Test Mode). ESPN not listing them is expected, not a
//     cancellation.
//   * Games someone has picked. Deleting one would leave that pick with no
//     game to grade against; an admin should resolve it instead.
async function pruneMissingGames(
  supabase: SupabaseClient,
  slateId: string,
  listed: Set<string>
): Promise<void> {
  const [{ data: stored }, { data: picks }] = await Promise.all([
    supabase.from('games').select('id, espn_event_id, home_team, away_team').eq('slate_id', slateId),
    supabase.from('picks').select('team').eq('slate_id', slateId),
  ])
  const pickedTeams = new Set((picks ?? []).map((pick: { team: string }) => pick.team))

  const staleIds: string[] = []
  for (const game of stored ?? []) {
    if (listed.has(game.espn_event_id)) continue
    if (!isEspnSourced(game.espn_event_id)) continue
    if (pickedTeams.has(game.home_team) || pickedTeams.has(game.away_team)) {
      console.warn(`ESPN no longer lists ${game.away_team}@${game.home_team} (${game.espn_event_id}), but it has picks — keeping it`)
      continue
    }
    staleIds.push(game.id)
  }
  if (staleIds.length > 0) {
    await supabase.from('games').delete().in('id', staleIds)
  }
}

export function isEspnSourced(espnEventId: string): boolean {
  return !espnEventId.startsWith('manual:') && !espnEventId.startsWith('sandbox:')
}
