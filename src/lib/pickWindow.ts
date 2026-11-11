import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Pick as StoredPick, Slate } from '@/types'
import type { PoolConfig } from './competition'
import { buildPickPeriods, sharedRoundPickQuota } from './competition'
import { didPickWin, isSlateLocked } from './deadline'
import { fetchDayScoreboard, resultOf } from './espn'
import { loadGamesForSlates } from './seasonData'
import { isTestMode } from './testMode'
import { ambiguousAbbreviations } from './teams'

type PlayerPick = Pick<StoredPick, 'id' | 'team' | 'slate_id' | 'auto_assigned' | 'loss_excused' | 'updated_at' | 'version'>

// This runs on every pick-page view and pick submission, so everything it
// asks ESPN goes through Next's shared fetch cache: one scoreboard read per
// date per window for the whole site, not one per player per refresh.
// It only reads: the next day's schedule comes from the scheduled schedule
// sync, the day turnover and the organizer's season sync, never from a view.
const RESULT_REFRESH_SECONDS = 30

// The active day remains active for scoring and grading. Once a player's
// previous selection is final and won, only that player can see the next day.
// This keeps late games from shortening early winners' next pick window.
export async function loadPickWindow(
  db: SupabaseClient,
  playerId: string,
  pool: PoolConfig,
  now: Date,
  allowEarly = true
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
  const seasonSlates = ((slates ?? []) as Slate[]).filter(slate => !pool.starts_on || slate.slate_date >= pool.starts_on)
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
        const byEvent = new Map(events.map((event) => [event.id, resultOf(event)]))
        // A shared abbreviation cannot say which game the pick is on.
        const ambiguous = ambiguousAbbreviations(games.filter((game) => game.slate_id === slateId))
        games = games.map((game) => game.slate_id === slateId && byEvent.has(game.espn_event_id) &&
          !ambiguous.has(game.home_team) && !ambiguous.has(game.away_team)
          ? { ...game, result: byEvent.get(game.espn_event_id)! }
          : game)
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
    const next = seasonSlates.find((slate) => slate.slate_date === date)
    const nextId = next?.id
    const nextGames = nextId ? games.filter((game) => game.slate_id === nextId) : []
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
