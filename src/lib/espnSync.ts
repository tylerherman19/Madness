import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchDayScoreboard,
  fetchApRankings,
  eventCompetitors,
  parseRound,
  broadcastOf,
  resultOf,
  reportsFinal,
  describeFeedState,
  seedOf,
  centralDateOf,
  easternDateOf,
  isTimeTbd,
  CONFERENCES,
} from './espn'
import { getOrCreateSlate, refreshLockTime, renumberSlates } from './slates'
import { selectAllIn } from './db'
import { ambiguousAbbreviations } from './teams'

export interface SyncResult {
  ok: boolean
  error?: string
  slateId?: string
  gamesSynced?: number
  teamsSeen?: number
  // Failed conferences or validation/review gates. Never prune an incomplete feed.
  partial?: string[]
  reviewGames?: string[]
}

// Sync one day's games from ESPN into `supabase` (the caller passes getDb()'s
// result so this routes to prod or the test sandbox correctly).
//
// `yyyymmdd` is the playing date in Central time. A UTC-next-day tip still
// belongs here when its Central date matches. TBD dates use ESPN's Eastern
// placeholder convention. A response for another playing day is incomplete.
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
  const requestedDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
  if (!/^\d{8}$/.test(yyyymmdd) || !Number.isFinite(Date.parse(`${requestedDate}T12:00:00Z`)) ||
    new Date(`${requestedDate}T12:00:00Z`).toISOString().slice(0, 10) !== requestedDate) {
    return { ok: false, error: 'Invalid schedule date' }
  }
  const { events, failedGroups } = await fetchDayScoreboard(yyyymmdd, revalidateSeconds)

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
    const teams = eventCompetitors(event)
    if (!event.id || !teams?.home.team.abbreviation || !teams.away.team.abbreviation) {
      return { ok: false, error: 'Schedule feed contains incomplete game data; keeping the saved schedule.', partial: [...failedGroups, 'invalid-event'] }
    }
    if (!Number.isFinite(Date.parse(event.date))) {
      return { ok: false, error: 'Schedule feed contains an invalid game date; keeping the saved schedule.', partial: [...failedGroups, 'invalid-date'] }
    }
    const date = isTimeTbd(event) ? easternDateOf(event.date) : centralDateOf(event.date)
    if (date !== requestedDate) {
      return { ok: false, error: 'Schedule feed contains games for another playing date; keeping the saved schedule.', partial: [...failedGroups, 'date-mismatch'] }
    }
    const bucket = byDate.get(date)
    if (bucket) bucket.push(event)
    else byDate.set(date, [event])
  }

  // Read before creating/updating slates. This gives known changes a clear
  // review incident; migration 028 also serializes against racing pick saves.
  let storedGames: StoredGame[]
  let storedSlates: { id: string; slate_date: string }[]
  const held = new Map<string, string>()
  const oriented = new Map<string, typeof events[number]>()
  const reliable = process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true'
  try {
    storedGames = await selectAllIn<StoredGame>(events.map(event => event.id), (batch, from, to) =>
      supabase.from('games').select(`id,espn_event_id,slate_id,home_team,away_team,result${reliable ? ',home_team_id,away_team_id,result_source' : ''}`)
        .in('espn_event_id', batch).order('id').range(from, to))
    storedSlates = await selectAllIn<{ id: string; slate_date: string }>(storedGames.map(game => game.slate_id), (batch, from, to) =>
      supabase.from('slates').select('id,slate_date').in('id', batch).order('id').range(from, to))
    const slateDates = new Map(storedSlates.map(slate => [slate.id, slate.slate_date]))
    const eventsById = new Map(events.map(event => [event.id, event]))
    const changes = storedGames.filter(game => {
      const event = eventsById.get(game.espn_event_id)!
      if (slateDates.get(game.slate_id) !== requestedDate) return true
      const teams = eventCompetitors(event)!
      // Keep the saved orientation so existing pick links and frozen snapshots
      // stay valid. Move the entire competitor (including winner and score).
      if (event.competitions[0].neutralSite === true &&
          game.home_team_id && game.away_team_id && game.home_team_id !== game.away_team_id &&
          game.home_team_id === teams.away.team.id && game.away_team_id === teams.home.team.id &&
          game.home_team === teams.away.team.abbreviation && game.away_team === teams.home.team.abbreviation) {
        const competition = event.competitions[0]
        const home = { ...teams.away, homeAway: 'home' as const }
        const away = { ...teams.home, homeAway: 'away' as const }
        oriented.set(event.id, { ...event, competitions: [{ ...competition, competitors: [home, away] }, ...event.competitions.slice(1)] })
        return false
      }
      return game.home_team !== teams.home.team.abbreviation || game.away_team !== teams.away.team.abbreviation ||
        (reliable && ((game.home_team_id != null && game.home_team_id !== (teams.home.team.id ?? null)) ||
          (game.away_team_id != null && game.away_team_id !== (teams.away.team.id ?? null))))
    })
    const picks = await selectAllIn<{ slate_id: string }>(changes.map(game => game.slate_id), (batch, from, to) =>
      supabase.from('picks').select('id,slate_id').in('slate_id', batch).order('id').range(from, to))
    const pickedSlates = new Set(picks.map(pick => pick.slate_id))
    const protectedGames = changes.filter(game => pickedSlates.has(game.slate_id))
    for (const game of protectedGames) held.set(game.espn_event_id, game.id)
    if (held.size) await recordScheduleReview(supabase, reliable, requestedDate, [...held.values()])
    if (held.size === events.length) {
      return { ok: false, error: 'All games are held for schedule review.', reviewGames: [...held.values()] }
    }
  } catch {
    return { ok: false, error: 'Could not verify schedule integrity; keeping the saved schedule.', partial: [...failedGroups, 'schedule-integrity'] }
  }

  const { data: currentActive } = await supabase
    .from('slates')
    .select('id')
    .eq('is_active', true)
    .maybeSingle()

  const teamRows = new Map<string, Record<string, unknown>>()
  let totalGames = 0
  let primarySlateId: string | undefined

  for (const [slateDate, dayEvents] of byDate) {
    const slate = await getOrCreateSlate(supabase, slateDate, seasonYear)
    if ('error' in slate) return { ok: false, error: slate.error }
    const slateId = slate.id
    if (slateDate === requestedDate) primarySlateId = slateId

    const rows = []
    // An abbreviation that appears more than once on a day (two schools ESPN
    // writes the same way) cannot say which game a pick belongs to, so those
    // games are never graded automatically.
    const ambiguous = ambiguousAbbreviations(dayEvents.flatMap((dayEvent) => {
      const sides = eventCompetitors(dayEvent)
      return sides ? [{ home_team: sides.home.team.abbreviation ?? '', away_team: sides.away.team.abbreviation ?? '' }] : []
    }))
    const storedByEvent = new Map(storedGames.map((game) => [game.espn_event_id, game]))
    const ambiguousGames: string[] = []
    const keptResults: string[] = []

    for (const incoming of dayEvents) {
      if (held.has(incoming.id)) continue
      const event = oriented.get(incoming.id) ?? incoming
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
            ...(process.env.TOURNAMENT_RELIABILITY_ENABLED==='true'?{espn_id:c.team.id??null}:{}),
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
      const stored = storedByEvent.get(event.id)
      let result = resultOf(event)
      if (ambiguous.has(homeAbbr) || ambiguous.has(awayAbbr)) {
        ambiguousGames.push(event.id)
        result = 'pending'
      }
      // A stored final is never silently erased: a feed that no longer gives
      // a clear result (or a now-ambiguous team) keeps the saved outcome and
      // asks the organizer to look. A different definitive result is written
      // and flows through the result-correction trigger (migration 027).
      // An administrator's result (or void) outranks the feed; scores and status still refresh.
      if (stored?.result_source === 'admin' && stored.result) {
        result = stored.result as typeof result
      } else if (result === 'pending' && stored?.result && stored.result !== 'pending') {
        keptResults.push(stored.id)
        result = stored.result as typeof result
      }

      rows.push({
        slate_id: slateId,
        espn_event_id: event.id,
        home_team: homeAbbr,
        ...(process.env.TOURNAMENT_RELIABILITY_ENABLED==='true'?{home_team_id:teams.home.team.id??null,away_team_id:teams.away.team.id??null}:{}),
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
        result,
      })
    }

    if (ambiguousGames.length) {
      await recordReview(supabase, reliable, `team-identity:${slateDate}`,
        'Two games on this day share a team abbreviation. Their results are not graded automatically; set them by hand after checking which team each pick means.',
        { requested_date: slateDate, espn_event_ids: ambiguousGames, abbreviations: [...ambiguous] })
    }
    const gameIdsByEvent = new Map(storedGames.map((game) => [game.espn_event_id, game.id]))
    const eventByGameId = new Map(dayEvents.flatMap((event) => gameIdsByEvent.has(event.id) ? [[gameIdsByEvent.get(event.id)!, event] as const] : []))
    for (const gameId of keptResults) {
      const observed = describeFeedState(eventByGameId.get(gameId)!)
      await recordReview(supabase, reliable, `result-review:${gameId}`,
        `ESPN no longer reports a clear final for a game that already has a result (it now says: ${observed}). The saved result was kept; check the game before changing it.`,
        { requested_date: slateDate, game_id: gameId, observed })
    }

    if (rows.length > 0) {
      // Conflict on the ESPN event id — the same game arriving from two
      // conference calls updates one row rather than inserting twice.
      const { data: saved, error } = await supabase
        .from('games')
        .upsert(rows, { onConflict: 'espn_event_id' })
        .select('id,espn_event_id')
      if (error) {
        return { ok: false, error: `Failed to save games: ${error.message}` }
      }
      if (!saved || saved.length !== rows.length) {
        // 028 skips protected rows and records the incident atomically. A
        // smaller representation also fails closed if a response is truncated.
        const savedIds = new Set(saved?.map(row => row.espn_event_id))
        const missing = rows.filter(row => !savedIds.has(row.espn_event_id))
        const known = new Map(storedGames.map(game => [game.espn_event_id, game.id]))
        if (missing.some(row => !known.has(row.espn_event_id))) {
          return { ok: false, error: 'Could not verify all game writes.' }
        }
        for (const row of missing) held.set(row.espn_event_id, known.get(row.espn_event_id)!)
        await recordScheduleReview(supabase, reliable, requestedDate, [...held.values()])
      }
      totalGames += saved?.length ?? 0
      // ESPN calls a never-graded game final but the parser cannot trust it
      // (equal scores, contradictory flags, a third competitor): it would
      // stay pending with no sign why, so the organizer is told.
      const savedIds = new Map((saved ?? []).map((row) => [row.espn_event_id as string, row.id as string]))
      for (const incoming of dayEvents) {
        const known = storedByEvent.get(incoming.id)
        const gameId = known?.id ?? savedIds.get(incoming.id)
        if (!gameId || held.has(incoming.id) || ambiguousGames.includes(incoming.id)) continue
        if (known?.result && known.result !== 'pending') continue
        if (!reportsFinal(incoming) || resultOf(oriented.get(incoming.id) ?? incoming) !== 'pending') continue
        const observed = describeFeedState(incoming)
        await recordReview(supabase, reliable, `result-review:${gameId}`,
          `ESPN reports this game as final but the result could not be trusted (${observed}). It stays ungraded; set the result by hand after checking the score.`,
          { requested_date: slateDate, game_id: gameId, observed })
      }
    }

    if (slateDate === requestedDate && failedGroups.length === 0 && !held.size) {
      if (!await pruneMissingGames(supabase, slateId, new Set(rows.map((r) => r.espn_event_id)))) {
        return { ok: false, error: 'Schedule cleanup was incomplete; saved games were kept for review.', partial: ['schedule-review'] }
      }
    }

    // Manual games count; placeholder tips do not.
    await refreshLockTime(supabase, slateId)
    // Save the AP snapshot the tournament auto-pick breaks seed-line ties
    // with, refreshed until lock and fixed after it. An empty (failed) read
    // never replaces a saved one. Durable automation requires the column;
    // the legacy path tolerates a database without migration 024.
    const ranks = await fetchApRankings()
    if (Object.keys(ranks).length > 0) {
      const { error: rankError } = await supabase.from('slates').update({ assignment_rankings: ranks }).eq('id', slateId)
        .or(`locks_at.is.null,locks_at.gt.${new Date().toISOString()}`)
      if (rankError && process.env.AUTOMATION_V2_ENABLED === 'true') throw rankError
    }
  }

  // A permitted move of an unpicked event also changes its previous day's
  // earliest tip. The database refreshes both pre-lock assignment snapshots.
  for (const slate of storedSlates) {
    if (slate.slate_date !== requestedDate) await refreshLockTime(supabase, slate.id)
  }

  await renumberSlates(supabase, seasonYear)

  if (teamRows.size > 0) {
    const { error } = await supabase.from('teams').upsert([...teamRows.values()], { onConflict: 'abbr' })
    if (error) return { ok: false, error: `Failed to save team directory: ${error.message}` }
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
    reviewGames: held.size ? [...held.values()] : undefined,
  }
}

interface StoredGame {
  id: string
  espn_event_id: string
  slate_id: string
  home_team: string
  away_team: string
  home_team_id?: string | null
  away_team_id?: string | null
  result?: string
  result_source?: string
}

async function recordScheduleReview(db: SupabaseClient, reliable: boolean, date: string, gameIds: string[]): Promise<void> {
  const message = 'Schedule identity changed after picks. Review the affected games before changing periods, teams or outcomes.'
  await recordReview(db, reliable, `schedule-sync:${date}`, message, { requested_date: date, game_ids: gameIds }, 'schedule-change')
}

// Organizer-visible review item: an incident (migration 025/026) when the
// reliability schema is active, otherwise an audit-log entry. The sync runs
// every minute, so a condition is raised once per distinct observed state:
// when the state recorded last time for this key is identical, nothing is
// written (record_incident would otherwise reopen it and count it again).
async function recordReview(db: SupabaseClient, reliable: boolean, key: string, message: string,
  details: Record<string, unknown>, legacyEvent = 'job-failed'): Promise<void> {
  const state = JSON.stringify(details)
  if (reliable) {
    const detail = state.slice(0, 1000)
    const { data: last, error: readError } = await db.from('incidents').select('details,impact').eq('key', key).maybeSingle()
    if (readError) throw readError
    if (last && last.details === detail && last.impact === message) return
    const { error } = await db.rpc('record_incident', { p_key: key, p_impact: message,
      p_correlation: randomUUID(), p_detail: detail })
    if (error) throw error
  } else {
    // Pre-025 deployments have neither incidents nor stable team/game columns.
    const { data: recent, error: readError } = await db.from('audit_log').select('details,message')
      .eq('event_type', legacyEvent).order('created_at', { ascending: false }).limit(50)
    if (readError) throw readError
    const same = (row: { details?: Record<string, unknown> | null }) => legacyEvent === 'schedule-change'
      ? row.details?.requested_date === details.requested_date
      : row.details?.key === key
    const last = (recent ?? []).find(same) as { details: Record<string, unknown>; message: string } | undefined
    if (last) {
      const lastState = Object.fromEntries(Object.entries(last.details ?? {}).filter(([name]) => name !== 'key'))
      if (JSON.stringify(lastState) === state && last.message === message) return
    }
    const { error } = await db.from('audit_log').insert({ event_type: legacyEvent, actor: 'system', message,
      details: legacyEvent === 'schedule-change' ? details : { key, ...details } })
    if (error) throw error
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
): Promise<boolean> {
  let stored: StoredGame[]
  let picks: { team: string }[]
  try {
    [stored, picks] = await Promise.all([
      selectAllIn<StoredGame>([slateId], (batch, from, to) => supabase.from('games')
        .select('id,espn_event_id,home_team,away_team').in('slate_id', batch).order('id').range(from, to)),
      selectAllIn<{ team: string }>([slateId], (batch, from, to) => supabase.from('picks')
        .select('id,team').in('slate_id', batch).order('id').range(from, to)),
    ])
  } catch { return false }
  const pickedTeams = new Set(picks.map(pick => pick.team))

  const staleIds: string[] = []
  for (const game of stored) {
    if (listed.has(game.espn_event_id)) continue
    if (!isEspnSourced(game.espn_event_id)) continue
    if (pickedTeams.has(game.home_team) || pickedTeams.has(game.away_team)) {
      console.warn(`ESPN no longer lists ${game.away_team}@${game.home_team} (${game.espn_event_id}), but it has picks — keeping it`)
      continue
    }
    staleIds.push(game.id)
  }
  if (staleIds.length > 0) {
    const { data, error } = await supabase.from('games').delete().in('id', staleIds).select('id')
    if (error || data?.length !== staleIds.length) return false
  }
  return true
}

export function isEspnSourced(espnEventId: string): boolean {
  return !espnEventId.startsWith('manual:') && !espnEventId.startsWith('sandbox:')
}
