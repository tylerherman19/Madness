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
  seedOf,
  centralDateOf,
  easternDateOf,
  isTimeTbd,
  CONFERENCES,
} from './espn'
import { getOrCreateSlate, refreshLockTime, renumberSlates } from './slates'
import { selectAllIn } from './db'

export interface SyncResult {
  ok: boolean
  error?: string
  slateId?: string
  gamesSynced?: number
  teamsSeen?: number
  // Failed conferences or validation/review gates. Never prune an incomplete feed.
  partial?: string[]
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
  const reliable = process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true'
  try {
    storedGames = await selectAllIn<StoredGame>(events.map(event => event.id), (batch, from, to) =>
      supabase.from('games').select(`id,espn_event_id,slate_id,home_team,away_team${reliable ? ',home_team_id,away_team_id' : ''}`)
        .in('espn_event_id', batch).order('id').range(from, to))
    storedSlates = await selectAllIn<{ id: string; slate_date: string }>(storedGames.map(game => game.slate_id), (batch, from, to) =>
      supabase.from('slates').select('id,slate_date').in('id', batch).order('id').range(from, to))
    const slateDates = new Map(storedSlates.map(slate => [slate.id, slate.slate_date]))
    const changes = storedGames.filter(game => {
      const event = events.find(event => event.id === game.espn_event_id)!
      const teams = eventCompetitors(event)
      return slateDates.get(game.slate_id) !== requestedDate || (teams && (
        game.home_team !== teams.home.team.abbreviation || game.away_team !== teams.away.team.abbreviation ||
        (reliable && ((game.home_team_id != null && game.home_team_id !== (teams.home.team.id ?? null)) ||
          (game.away_team_id != null && game.away_team_id !== (teams.away.team.id ?? null))))))
    })
    const picks = await selectAllIn<{ slate_id: string }>(changes.map(game => game.slate_id), (batch, from, to) =>
      supabase.from('picks').select('id,slate_id').in('slate_id', batch).order('id').range(from, to))
    const pickedSlates = new Set(picks.map(pick => pick.slate_id))
    const protectedGames = changes.filter(game => pickedSlates.has(game.slate_id))
    if (protectedGames.length > 0) {
      await recordScheduleReview(supabase, reliable, requestedDate, protectedGames.map(game => game.id))
      return { ok: false, error: 'A picked schedule changed; keeping the saved games for manual review.', partial: [...failedGroups, 'schedule-review'] }
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
        result: resultOf(event),
      })
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
        await recordScheduleReview(supabase, reliable, requestedDate, storedGames.map(game => game.id))
        return { ok: false, error: 'A schedule change was held for manual review.', partial: [...failedGroups, 'schedule-review'] }
      }
      totalGames += rows.length
    }

    if (slateDate === requestedDate && failedGroups.length === 0) {
      if (!await pruneMissingGames(supabase, slateId, new Set(rows.map((r) => r.espn_event_id)))) {
        return { ok: false, error: 'Schedule cleanup was incomplete; saved games were kept for review.', partial: ['schedule-review'] }
      }
    }

    // Manual games count; placeholder tips do not.
    await refreshLockTime(supabase, slateId)
    if (process.env.AUTOMATION_V2_ENABLED === 'true') {
      const ranks = await fetchApRankings()
      if (Object.keys(ranks).length > 0) {
        const { error: rankError } = await supabase.from('slates').update({ assignment_rankings: ranks }).eq('id', slateId)
          .or(`locks_at.is.null,locks_at.gt.${new Date().toISOString()}`)
        if (rankError) throw rankError
      }
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
}

async function recordScheduleReview(db: SupabaseClient, reliable: boolean, date: string, gameIds: string[]): Promise<void> {
  const message = 'Schedule identity changed after picks. Review the affected games before changing periods, teams or outcomes.'
  const details = { requested_date: date, game_ids: gameIds }
  if (reliable) {
    const { error } = await db.rpc('record_incident', { p_key: `schedule-sync:${date}`, p_impact: message,
      p_correlation: randomUUID(), p_detail: JSON.stringify(details).slice(0, 1000) })
    if (error) throw error
  } else {
    // Pre-025 deployments have neither incidents nor stable team/game columns.
    const { error } = await db.from('audit_log').insert({ event_type: 'schedule-change', actor: 'system', message, details })
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
