import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Pick as StoredPick, Slate } from '@/types'
import type { PoolConfig } from './competition'
import { buildPickPeriods, sharedRoundPickQuota } from './competition'
import { didPickWin, isSlateLocked } from './deadline'
import {
  broadcastOf, centralDateOf, easternDateOf, eventCompetitors, fetchDayScoreboard, isTimeTbd,
  parseRound, resultOf, scheduledEventSides, seedOf, type EspnEvent,
} from './espn'
import { syncSlateFromEspn } from './espnSync'
import { loadGamesForSlates } from './seasonData'
import { isTestMode } from './testMode'
import { ambiguousAbbreviations } from './teams'

type PlayerPick = Pick<StoredPick, 'id' | 'team' | 'slate_id' | 'auto_assigned' | 'loss_excused' | 'updated_at' | 'version'>

// This runs on every pick-page view and pick submission, so everything it
// asks ESPN goes through Next's shared fetch cache: one scoreboard read per
// date per window for the whole site, not one per player per refresh.
// A page view only reads. Tomorrow's schedule normally arrives from the
// scheduled schedule sync; when it has not, a view shows ESPN's games from
// memory under a placeholder id, and only the pick submission for that day
// stores it (see `storeDate`).
const RESULT_REFRESH_SECONDS = 30
const NEXT_DAY_REVALIDATE_SECONDS = 300

// Placeholder id of a next day that is not stored yet: `espn:YYYY-MM-DD`.
export const UNSTORED_DAY = /^espn:(\d{4}-\d{2}-\d{2})$/

type NextDay = { slate: Slate; games: Game[] } | 'dark' | 'stop'

// The day's games straight from ESPN, never written. Refused (stop) on the
// same incomplete-feed conditions the sync refuses.
async function previewDay(date: string, seasonYear: number, number: number): Promise<NextDay> {
  let scoreboard: Awaited<ReturnType<typeof fetchDayScoreboard>>
  try {
    scoreboard = await fetchDayScoreboard(date.replace(/-/g, ''), NEXT_DAY_REVALIDATE_SECONDS)
  } catch (error) {
    console.error('Could not read the next game day', error)
    return 'stop'
  }
  const { events, failedGroups } = scoreboard
  if (failedGroups.length > 0) return 'stop'
  if (events.length === 0) return 'dark'
  const id = `espn:${date}`
  const games: Game[] = []
  for (const event of events) {
    const sides = eventCompetitors(event)
    if (!event.id || !sides?.home.team.abbreviation || !sides.away.team.abbreviation) return 'stop'
    if (!Number.isFinite(Date.parse(event.date))) return 'stop'
    const tbd = isTimeTbd(event)
    if ((tbd ? easternDateOf(event.date) : centralDateOf(event.date)) !== date) return 'stop'
    const { roundLabel, region } = parseRound(event)
    games.push({
      id: `espn:${event.id}`, slate_id: id, espn_event_id: event.id,
      home_team: sides.home.team.abbreviation, away_team: sides.away.team.abbreviation,
      home_seed: seedOf(sides.home), away_seed: seedOf(sides.away),
      tip_time: event.date, time_tbd: tbd, round_label: roundLabel, region,
      venue: event.competitions[0].venue?.fullName ?? null, tv: broadcastOf(event),
      status_state: 'pre', period: null, display_clock: null, home_score: null, away_score: null,
      result: 'pending', created_at: event.date,
    })
  }
  const slate: Slate = { id, slate_number: number, slate_date: date, season_year: seasonYear, is_active: false, locks_at: null, created_at: events[0].date }
  return { slate, games }
}

// The submission path: store the day through the guarded sync, then read it
// back. Anything the sync refuses (failed conference, bad feed) stops here.
async function storeDay(db: SupabaseClient, date: string, seasonYear: number): Promise<NextDay> {
  let synced: Awaited<ReturnType<typeof syncSlateFromEspn>>
  try {
    synced = await syncSlateFromEspn(db, date.replace(/-/g, ''), seasonYear, { revalidateSeconds: NEXT_DAY_REVALIDATE_SECONDS })
  } catch (error) {
    console.error('Could not load the next game day', error)
    return 'stop'
  }
  if (!synced.ok && synced.error?.startsWith('No games found')) return 'dark'
  if (!synced.ok || synced.partial?.length || !synced.slateId) return 'stop'
  const [{ data: slate }, stored] = await Promise.all([
    db.from('slates').select('*').eq('id', synced.slateId).maybeSingle(),
    loadGamesForSlates(db, [synced.slateId]),
  ])
  return slate ? { slate: slate as Slate, games: stored } : 'stop'
}

// The result of ESPN's event in the stored game's orientation. A neutral-site
// game ESPN lists the other way round is matched on team identity, so the
// winner stays the winner whichever side the feed calls home. A game whose
// teams differ from the stored row is someone else's result: left pending.
function storedOrientation(game: Game, event: EspnEvent): Game['result'] {
  const sides = scheduledEventSides(game, event)
  if (!sides) return game.result
  const result = resultOf(event)
  if (!sides.flipped || result === 'pending') return result
  return result === 'home_win' ? 'away_win' : 'home_win'
}

// The active day remains active for scoring and grading. Once a player's
// previous selection is final and won, only that player can see the next day.
// This keeps late games from shortening early winners' next pick window.
export async function loadPickWindow(
  db: SupabaseClient,
  playerId: string,
  pool: PoolConfig,
  now: Date,
  allowEarly = true,
  // The unstored next day this request is about to save a pick on (POST only).
  storeDate: string | null = null
): Promise<{
  activeSlate: Slate | null
  pickSlate: Slate | null
  seasonSlates: Slate[]
  games: Game[]
  picks: PlayerPick[]
}> {
  const { data: activeSlate, error: activeError } = await db.from('slates').select('*').eq('is_active', true).maybeSingle()
  if (activeError) throw activeError
  if (!activeSlate) return { activeSlate: null, pickSlate: null, seasonSlates: [], games: [], picks: [] }

  const readPicks=db.from('picks')
  const playerPickQuery=process.env.TOURNAMENT_RELIABILITY_ENABLED==='true'
    ? readPicks.select('id, team, slate_id, auto_assigned, loss_excused, updated_at, version').eq('player_id',playerId)
    : readPicks.select('id, team, slate_id, auto_assigned, loss_excused, updated_at').eq('player_id',playerId)
  const [slatesRes, picksRes] = await Promise.all([
    db.from('slates').select('*').eq('season_year', activeSlate.season_year),
    playerPickQuery,
  ])
  if (slatesRes.error) throw slatesRes.error
  if (picksRes.error) throw picksRes.error
  const slates = slatesRes.data
  const picks = picksRes.data
  let seasonSlates = ((slates ?? []) as Slate[]).filter(slate => !pool.starts_on || slate.slate_date >= pool.starts_on)
  const playerPicks = (picks ?? []) as PlayerPick[]
  let games = await loadGamesForSlates(db, seasonSlates.map((slate) => slate.id))
  const activeGames = games.filter((game) => game.slate_id === activeSlate.id)

  if (!allowEarly || !isSlateLocked(activeSlate, activeGames, now)) {
    return { activeSlate, pickSlate: activeSlate, seasonSlates, games, picks: playerPicks }
  }

  const periods = buildPickPeriods(pool.competition_mode, seasonSlates, games)
  const currentPeriod = periods.find((period) => period.id === activeSlate.id)
  const sharedQuota = sharedRoundPickQuota(
    pool.competition_mode, pool.pick_frequency, currentPeriod?.round ?? null
  )
  const currentIds = sharedQuota
    ? new Set(periods.filter((period) => period.round === currentPeriod?.round).map((period) => period.id))
    : new Set([activeSlate.id])
  const currentPicks = playerPicks.filter((pick) => currentIds.has(pick.slate_id))
  if (currentPicks.length === 0) {
    return { activeSlate, pickSlate: activeSlate, seasonSlates, games, picks: playerPicks }
  }

  // The results cron runs on a schedule. Check ESPN on demand so a final at
  // 3 PM opens the next day without waiting for the overnight cron. Sandbox
  // games use their stored results and never call the production scoreboard.
  const sandbox = await isTestMode()
  if (!sandbox && currentPicks.some((pick) => {
    const game = games.find((g) => g.slate_id === pick.slate_id && (g.home_team === pick.team || g.away_team === pick.team))
    return !game || game.result === 'pending'
  })) {
    for (const slateId of new Set(currentPicks.map((pick) => pick.slate_id))) {
      const slate = seasonSlates.find((row) => row.id === slateId)
      if (!slate) continue
      try {
        const { events } = await fetchDayScoreboard(slate.slate_date.replace(/-/g, ''), RESULT_REFRESH_SECONDS)
        const byEvent = new Map(events.map((event) => [event.id, event]))
        // A shared abbreviation cannot say which game the pick is on.
        const ambiguous = ambiguousAbbreviations(games.filter((game) => game.slate_id === slateId))
        games = games.map((game) => {
          const event = game.slate_id === slateId ? byEvent.get(game.espn_event_id) : undefined
          if (!event || ambiguous.has(game.home_team) || ambiguous.has(game.away_team)) return game
          return { ...game, result: storedOrientation(game, event) }
        })
      } catch (error) {
        console.error('Could not refresh pick result', error)
      }
    }
  }

  if (!currentPicks.every((pick) => didPickWin(pick, games))) {
    return { activeSlate, pickSlate: activeSlate, seasonSlates, games, picks: playerPicks }
  }

  // Find the first stored playing day, skipping dark days. A day with no
  // saved games yet is simply not offered early.
  const activeDate = new Date(`${activeSlate.slate_date}T12:00:00Z`)
  for (let offset = 1; offset <= 10; offset++) {
    const date = new Date(activeDate.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
    let next = seasonSlates.find((slate) => slate.slate_date === date)
    let nextGames = next ? games.filter((game) => game.slate_id === next!.id) : []
    if (nextGames.length === 0 && !sandbox) {
      const loaded = storeDate === date
        ? await storeDay(db, date, activeSlate.season_year)
        : await previewDay(date, activeSlate.season_year, Math.max(0, ...seasonSlates.map((slate) => slate.slate_number)) + 1)
      if (loaded === 'dark') continue
      if (loaded === 'stop') break
      next = loaded.slate
      nextGames = loaded.games
      seasonSlates = [...seasonSlates.filter((slate) => slate.id !== next!.id), next]
      games = [...games.filter((game) => game.slate_id !== next!.id), ...nextGames]
    }
    if (!next || nextGames.length === 0) continue

    const nextPeriod = buildPickPeriods(pool.competition_mode, seasonSlates, games)
      .find((period) => period.id === next.id)
    if (sharedQuota && nextPeriod?.round !== currentPeriod?.round && currentPicks.length < sharedQuota) {
      break
    }
    if (isSlateLocked(next, nextGames, now)) break
    return { activeSlate, pickSlate: next, seasonSlates, games, picks: playerPicks }
  }

  return { activeSlate, pickSlate: activeSlate, seasonSlates, games, picks: playerPicks }
}
