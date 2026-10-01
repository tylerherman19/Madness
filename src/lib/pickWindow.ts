import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Pick as StoredPick, Slate } from '@/types'
import type { PickPeriodGame, PoolConfig } from './competition'
import { buildPickPeriods, capabilitiesFor, sharedRoundPickQuota } from './competition'
import { didPickWin, isSlateLocked } from './deadline'
import { fetchDayScoreboard, resultOf } from './espn'
import { syncSlateFromEspn } from './espnSync'
import { loadGamesForSlates, loadRoundLabels } from './seasonData'
import { isTestMode } from './testMode'

type PlayerPick = Pick<StoredPick, 'id' | 'team' | 'slate_id' | 'auto_assigned'>

// This runs on every pick-page view and pick submission, so everything it
// asks ESPN goes through Next's shared fetch cache: one scoreboard read per
// date per window for the whole site, not one per player per refresh.
const RESULT_REFRESH_SECONDS = 30
const NEXT_DAY_REVALIDATE_SECONDS = 300
// A next day synced this recently is read straight from the database.
const NEXT_DAY_FRESH_MS = 10 * 60 * 1000

function recentlySynced(slate: Slate | undefined): boolean {
  const syncedAt = (slate as (Slate & { synced_at?: string | null }) | undefined)?.synced_at
  if (!syncedAt) return false
  return Date.now() - new Date(syncedAt).getTime() < NEXT_DAY_FRESH_MS
}

export interface PickWindow {
  activeSlate: Slate | null
  pickSlate: Slate | null
  seasonSlates: Slate[]
  // Full game rows for the days the window looked at — the active day, the
  // days of the player's picks in the current period, and the day it offers
  // (pickSlate). Deliberately not the whole season: that is thousands of
  // rows on every pick-page view. Callers only read the day they were handed.
  games: Game[]
  // Slate and round of the season's tournament games: everything pick
  // periods are built from. Empty outside march-madness mode, where periods
  // don't use games at all.
  periodGames: PickPeriodGame[]
  picks: PlayerPick[]
}

// The active day remains active for scoring and grading. Once a player's
// previous selection is final and won, only that player can see the next day.
// This keeps late games from shortening early winners' next pick window.
export async function loadPickWindow(
  db: SupabaseClient,
  playerId: string,
  pool: PoolConfig,
  now: Date,
  allowEarly = true
): Promise<PickWindow> {
  const { data: activeSlate } = await db.from('slates').select('*').eq('is_active', true).maybeSingle()
  if (!activeSlate) {
    return { activeSlate: null, pickSlate: null, seasonSlates: [], games: [], periodGames: [], picks: [] }
  }

  const [{ data: slates }, { data: picks }] = await Promise.all([
    db.from('slates').select('*').eq('season_year', activeSlate.season_year),
    db.from('picks').select('id, team, slate_id, auto_assigned').eq('player_id', playerId),
  ])
  let seasonSlates = (slates ?? []) as Slate[]
  const playerPicks = (picks ?? []) as PlayerPick[]

  // Full rows, one day at a time, as the window needs them.
  const gamesBySlate = new Map<string, Game[]>()
  const loadDays = async (slateIds: string[]) => {
    const missing = [...new Set(slateIds)].filter((id) => !gamesBySlate.has(id))
    if (missing.length === 0) return
    const rows = await loadGamesForSlates(db, missing)
    for (const id of missing) gamesBySlate.set(id, [])
    for (const game of rows) gamesBySlate.get(game.slate_id)?.push(game)
  }

  const tournament = capabilitiesFor(pool.competition_mode).showTournamentRounds
  let periodGames: PickPeriodGame[] = []
  await Promise.all([
    loadDays([activeSlate.id]),
    tournament
      ? loadRoundLabels(db, seasonSlates.map((slate) => slate.id)).then((rows) => { periodGames = rows })
      : Promise.resolve(),
  ])

  const windowFor = (pickSlate: Slate): PickWindow => ({
    activeSlate,
    pickSlate,
    seasonSlates,
    games: [...gamesBySlate.values()].flat(),
    periodGames,
    picks: playerPicks,
  })

  const activeGames = gamesBySlate.get(activeSlate.id) ?? []
  if (!allowEarly || !isSlateLocked(activeSlate, activeGames, now)) return windowFor(activeSlate)

  const periods = buildPickPeriods(pool.competition_mode, seasonSlates, periodGames)
  const currentPeriod = periods.find((period) => period.id === activeSlate.id)
  const sharedQuota = sharedRoundPickQuota(
    pool.competition_mode, pool.pick_frequency, currentPeriod?.round ?? null
  )
  const currentIds = sharedQuota
    ? new Set(periods.filter((period) => period.round === currentPeriod?.round).map((period) => period.id))
    : new Set([activeSlate.id])
  const currentPicks = playerPicks.filter((pick) => currentIds.has(pick.slate_id))
  if (currentPicks.length === 0) return windowFor(activeSlate)

  // Each current pick is judged against its own day's games.
  const pickSlateIds = [...new Set(currentPicks.map((pick) => pick.slate_id))]
  await loadDays(pickSlateIds)
  const gameOf = (pick: PlayerPick) =>
    (gamesBySlate.get(pick.slate_id) ?? []).find((g) => g.home_team === pick.team || g.away_team === pick.team)

  // The results cron runs on a schedule. Check ESPN on demand so a final at
  // 3 PM opens the next day without waiting for the overnight cron. Sandbox
  // games use their stored results and never call the production scoreboard.
  const sandbox = await isTestMode()
  if (!sandbox && currentPicks.some((pick) => {
    const game = gameOf(pick)
    return !game || game.result === 'pending'
  })) {
    for (const slateId of pickSlateIds) {
      const slate = seasonSlates.find((row) => row.id === slateId)
      if (!slate) continue
      try {
        const { events } = await fetchDayScoreboard(slate.slate_date.replace(/-/g, ''), RESULT_REFRESH_SECONDS)
        const byEvent = new Map(events.map((event) => [event.id, resultOf(event)]))
        gamesBySlate.set(slateId, (gamesBySlate.get(slateId) ?? []).map((game) => byEvent.has(game.espn_event_id)
          ? { ...game, result: byEvent.get(game.espn_event_id)! }
          : game))
      } catch (error) {
        console.error('Could not refresh pick result', error)
      }
    }
  }

  if (!currentPicks.every((pick) => didPickWin(pick, gamesBySlate.get(pick.slate_id) ?? []))) {
    return windowFor(activeSlate)
  }

  // Find the first playing day, including dark days. Sync it only after the
  // player has won; normal traffic to a locked slate need not scan ahead.
  const activeDate = new Date(`${activeSlate.slate_date}T12:00:00Z`)
  for (let offset = 1; offset <= 10; offset++) {
    const date = new Date(activeDate.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
    let next = seasonSlates.find((slate) => slate.slate_date === date)
    if (next) await loadDays([next.id])
    let nextGames = next ? gamesBySlate.get(next.id) ?? [] : []
    if (!sandbox && !(nextGames.length > 0 && recentlySynced(next))) {
      let synced: Awaited<ReturnType<typeof syncSlateFromEspn>>
      try {
        synced = await syncSlateFromEspn(db, date.replace(/-/g, ''), activeSlate.season_year, {
          revalidateSeconds: NEXT_DAY_REVALIDATE_SECONDS,
        })
      } catch (error) {
        console.error('Could not load the next game day', error)
        break
      }
      // A failed conference might contain the earliest tip. Wait for a full
      // schedule instead of offering a later deadline from incomplete data.
      if (synced.partial?.length || (!synced.ok && !synced.error?.startsWith('No games found'))) break
      if (!synced.ok && nextGames.length > 0) break
      if (synced.ok && synced.slateId) {
        const syncedId = synced.slateId
        const [{ data: freshSlates }, { data: freshGames }] = await Promise.all([
          db.from('slates').select('*').eq('season_year', activeSlate.season_year),
          db.from('games').select('*').eq('slate_id', syncedId),
        ])
        seasonSlates = (freshSlates ?? seasonSlates) as Slate[]
        next = seasonSlates.find((slate) => slate.id === syncedId)
        nextGames = (freshGames ?? []) as Game[]
        gamesBySlate.set(syncedId, nextGames)
        if (tournament) {
          periodGames = [
            ...periodGames.filter((game) => game.slate_id !== syncedId),
            ...nextGames
              .filter((game) => game.round_label)
              .map((game) => ({ slate_id: game.slate_id, round_label: game.round_label })),
          ]
        }
      }
    }
    if (!next || nextGames.length === 0) continue

    const nextPeriod = buildPickPeriods(pool.competition_mode, seasonSlates, periodGames)
      .find((period) => period.id === next.id)
    if (sharedQuota && nextPeriod?.round !== currentPeriod?.round && currentPicks.length < sharedQuota) {
      break
    }
    if (isSlateLocked(next, nextGames, now)) break
    return windowFor(next)
  }

  return windowFor(activeSlate)
}
