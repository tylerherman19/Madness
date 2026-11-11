import {allRows} from '@/lib/db'
import { getActivePoolId, contestFilter } from '@/lib/pool'
import { NextResponse, after, type NextRequest } from 'next/server'
import { getDb, isTestMode, getEffectiveNow } from '@/lib/testMode'
import { isDeliverable } from '@/lib/email'
import { fetchDayScoreboard, eventCompetitors, seedOf } from '@/lib/espn'
import { isPickRevealed } from '@/lib/deadline'
import { autoAssignIfDue } from '@/lib/autoAssign'
import type { Game } from '@/types'
import { loadPicksForSlates } from '@/lib/seasonData'
import { reportFailure } from '@/lib/alerts'
import { getTeamBrandDirectory } from '@/lib/sharedData'
import { cdnSeconds, feedCacheControl } from '@/lib/livePolling'
import { centralClock } from '@/lib/operationPolicy'

export interface LiveGame {
  id: string
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  state: 'pre' | 'in' | 'post'
  statusText: string  // e.g. "Q3 4:22", "Final", "7:30 PM ET"
  kickoff: string
  timeTbd?: boolean
  // NCAA tournament seeds, when the feed carries them.
  homeSeed?: number | null
  awaySeed?: number | null
  homeLogo?: string | null
  awayLogo?: string | null
  // Short display names, so the ticker needn't be sent the whole directory.
  homeName?: string
  awayName?: string
  homeColor?: string | null
  awayColor?: string | null
  homePicks?: number
  awayPicks?: number
  // False when the game's outcome is known but the numbers aren't — a
  // production schedule row carries `result` but has no score columns.
  scoresKnown?: boolean
}

export interface LiveScoresResponse {
  slateNumber: number | null
  games: LiveGame[]
  picksVisible: boolean
  hasLiveGames: boolean
  season: number | null
  // Where the games came from: the live ESPN scoreboard, or this pool's own
  // schedule table (the sandbox, or a slate ESPN can't serve yet).
  source: 'espn' | 'schedule' | 'none'
}

// Room for the auto-assign run this route may kick off after responding.
export const maxDuration = 60

const EMPTY: LiveScoresResponse = {
  slateNumber: null, games: [], picksVisible: false, hasLiveGames: false, season: null, source: 'none',
}

// Turn a row from our own `games` table into a ticker card. Sandbox rows carry
// admin-entered scores; production rows don't have score columns at all, so
// those show as a schedule card until ESPN takes over.
function gameFromSchedule(g: Game, now: Date, teams: Record<string, { logo: string | null }>): LiveGame {
  const kickoff = new Date(g.tip_time)
  const started = !g.time_tbd && !isNaN(kickoff.getTime()) && now >= kickoff
  const state: 'pre' | 'in' | 'post' =
    g.result !== 'pending' ? 'post' : started ? 'in' : 'pre'
  const scoresKnown = g.home_score != null && g.away_score != null

  let statusText: string
  if (state === 'post') {
    const winner =
      g.result === 'home_win' ? g.home_team : g.result === 'away_win' ? g.away_team : null
    statusText = scoresKnown ? 'Final' : winner ? `Final · ${winner}` : 'Final · tie'
  } else {
    statusText = state === 'in' ? 'In progress' : 'Scheduled'
  }

  return {
    id: g.id,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    homeScore: g.home_score ?? 0,
    awayScore: g.away_score ?? 0,
    state,
    statusText,
    kickoff: g.tip_time,
    timeTbd: g.time_tbd,
    scoresKnown,
    homeLogo: teams[g.home_team]?.logo ?? null,
    awayLogo: teams[g.away_team]?.logo ?? null,
  }
}

// The CDN keeps a copy for up to a minute before a tip (never past it), 10
// seconds during games and 5 minutes once the day is done; see lib/livePolling.
// Test-mode browsers ask for ?sandbox=1, which is never stored, so a tester
// never sees the real pool's copy and the real pool never sees the sandbox.
const BEFORE_TIP_SECONDS = 60
// With no active day, check back within a minute so a newly opened one shows.
const NO_SLATE_SECONDS = 60

export async function GET(request: NextRequest) {
  try {
    const supabase = await getDb()
    const testMode = await isTestMode()
    const uncached = testMode || request.nextUrl.searchParams.has('sandbox')

    const now = await getEffectiveNow()
    const fields = 'id, slate_number, slate_date, season_year, locks_at, is_active'
    const { data: active, error: activeError } = await supabase
      .from('slates').select(fields).eq('is_active', true).maybeSingle()
    if (activeError) throw activeError

    let slate = active
    const today = centralClock(now).date
    if (!testMode && active && active.slate_date < today) {
      const current = await supabase.from('slates').select(fields)
        .eq('slate_date', today).eq('season_year', active.season_year).maybeSingle()
      if (current.error) throw current.error
      slate = current.data ?? active
    }

    if (!slate) {
      return NextResponse.json(EMPTY, { headers: { 'Cache-Control': feedCacheControl(uncached ? null : NO_SLATE_SECONDS) } })
    }

    const [dbGamesRes, teamsRes, events, directory] = await Promise.all([
      supabase.from('games').select('*').eq('slate_id', slate.id),
      supabase.from('teams').select('abbr, logo'),
      // Sandbox matchups are fabricated, so there is nothing to look up on the
      // real scoreboard — skip the network call entirely and read the sandbox
      // schedule (with its admin-entered scores) below.
      //
      // In production this is null when ESPN is down or served last season's
      // data (its silent fallback before the requested season starts), which
      // also falls through to the schedule.
      // 10s matches ESPN's own cache — asking more often returns the same
      // bytes, so this is the useful floor while games are in progress.
      testMode
        ? Promise.resolve(null)
        : fetchDayScoreboard(String(slate.slate_date).replace(/-/g, ''), 10)
            .then((r) => r.events)
            .catch(() => null),
      getTeamBrandDirectory(),
    ])

    // Every open page polls this ticker, so it is the heartbeat that fills in
    // missed picks within a minute or two of first tip. Runs after the
    // response is sent; a no-op until the slate locks and once it's done.
    after(() => autoAssignIfDue(supabase, now))

    if (dbGamesRes.error) throw dbGamesRes.error
    const dbGames = (dbGamesRes.data ?? []) as Game[]
    const teamRows = Object.fromEntries((teamsRes.data ?? []).map((team) => [team.abbr, team]))

    let games: LiveGame[] = []
    let source: LiveScoresResponse['source'] = 'none'

    const authoritativeEvents = new Map(dbGames.map(game => [game.espn_event_id, game]))
    for (const event of events ?? []) {
      const scheduled = authoritativeEvents.get(event.id)
      if (!scheduled) continue
      const teams = eventCompetitors(event)
      if (!teams) continue
      const status = event.competitions[0].status
      const homeAbbr = teams.home.team.abbreviation
      const awayAbbr = teams.away.team.abbreviation
      if (!homeAbbr || !awayAbbr) continue
      const sameSides = homeAbbr === scheduled.home_team && awayAbbr === scheduled.away_team
      const neutralSwap = event.competitions[0].neutralSite === true &&
        homeAbbr === scheduled.away_team && awayAbbr === scheduled.home_team
      if (!sameSides && !neutralSwap) continue
      games.push({
        id: event.id,
        homeTeam: homeAbbr,
        awayTeam: awayAbbr,
        homeScore: parseInt(teams.home.score ?? '0') || 0,
        awayScore: parseInt(teams.away.score ?? '0') || 0,
        state: status.type.state as 'pre' | 'in' | 'post',
        statusText: status.type.shortDetail ?? '',
        kickoff: scheduled.tip_time,
        timeTbd: scheduled.time_tbd,
        homeSeed: seedOf(teams.home),
        awaySeed: seedOf(teams.away),
        homeLogo: teams.home.team.logo ?? teams.home.team.logos?.[0]?.href ?? null,
        awayLogo: teams.away.team.logo ?? teams.away.team.logos?.[0]?.href ?? null,
        homeColor: teams.home.team.color ? `#${teams.home.team.color}` : null,
        awayColor: teams.away.team.color ? `#${teams.away.team.color}` : null,
      })
    }

    if (games.length > 0) {
      const liveIds = new Set(games.map(game => game.id))
      games.push(...dbGames.filter(game => !liveIds.has(game.espn_event_id)).map(game => gameFromSchedule(game, now, teamRows)))
      source = 'espn'
    } else if (dbGames.length > 0) {
      // No ESPN coverage (sandbox, or a slate it can't serve): show this pool's
      // own slate so the ticker still carries the schedule and any result the
      // admin has entered, instead of disappearing entirely.
      games = dbGames.map((g) => gameFromSchedule(g, now, teamRows))
      source = 'schedule'
    }

    games.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
    for (const game of games) {
      game.homeName = directory[game.homeTeam]?.shortName ?? game.homeTeam
      game.awayName = directory[game.awayTeam]?.shortName ?? game.awayTeam
    }

    const hasLiveGames = games.some((g) => g.state === 'in')

    // The slate locks as a unit at its first tip, so picks go public as a
    // unit too — there is no longer a per-team reveal to compute.
    const revealedTeams = new Set<string>()
    if (slate.is_active && isPickRevealed(slate, dbGames, now)) {
      for (const g of dbGames) {
        revealedTeams.add(g.home_team)
        revealedTeams.add(g.away_team)
      }
    }
    if (revealedTeams.size > 0) {
      // Fetch pick counts from DB, excluding test accounts
      const { data: allPlayers } = await allRows(supabase.from('players').select('id,email').match(contestFilter(await getActivePoolId(supabase))))

      const realPlayerIds = new Set(
        (allPlayers || [])
          .filter((p: { email: string }) => p.email && isDeliverable(p.email))
          .map((p: { id: string }) => p.id)
      )

      const picks = await loadPicksForSlates<{ player_id: string; team: string }>(supabase, [slate.id], 'player_id, team')

      const pickCounts: Record<string, number> = {}
      for (const pick of picks || []) {
        if (realPlayerIds.has(pick.player_id)) {
          pickCounts[pick.team] = (pickCounts[pick.team] || 0) + 1
        }
      }

      for (const game of games) {
        if (revealedTeams.has(game.homeTeam)) game.homePicks = pickCounts[game.homeTeam] ?? 0
        if (revealedTeams.has(game.awayTeam)) game.awayPicks = pickCounts[game.awayTeam] ?? 0
      }
    }

    return NextResponse.json({
      slateNumber: slate.slate_number,
      season: slate.season_year,
      games,
      picksVisible: revealedTeams.size > 0,
      hasLiveGames,
      source,
    } satisfies LiveScoresResponse, {
      headers: { 'Cache-Control': feedCacheControl(uncached ? null : cdnSeconds(games, hasLiveGames, BEFORE_TIP_SECONDS)) },
    })
  } catch (err) {
    console.error('live-scores error', err)
    await reportFailure(await getDb(), { kind: 'server-error', source: 'api/live-scores', message: 'api/live-scores returned 500', error: err })
    return NextResponse.json(EMPTY, { status: 500 })
  }
}
