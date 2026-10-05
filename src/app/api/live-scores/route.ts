import { NextResponse, after } from 'next/server'
import { getDb, isTestMode, getEffectiveNow } from '@/lib/testMode'
import { isDeliverable } from '@/lib/email'
import { fetchDayScoreboard, eventCompetitors, seedOf } from '@/lib/espn'
import { isSlateLocked } from '@/lib/deadline'
import { autoAssignIfDue } from '@/lib/autoAssign'
import type { Game } from '@/types'

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

export async function GET() {
  try {
    const supabase = await getDb()
    const testMode = await isTestMode()

    // Sandbox responses must never land in the shared CDN cache
    const cacheHeader = (maxAge: number, swr = 0) =>
      testMode
        ? 'private, no-store'
        : `public, max-age=${maxAge}${swr > 0 ? `, stale-while-revalidate=${swr}` : ''}`

    // Get active slate from our DB
    const { data: slate } = await supabase
      .from('slates')
      .select('id, slate_number, slate_date, season_year, locks_at')
      .eq('is_active', true)
      .single()

    if (!slate) {
      return NextResponse.json(EMPTY, { headers: { 'Cache-Control': cacheHeader(60) } })
    }

    const [dbGamesRes, events, now] = await Promise.all([
      supabase.from('games').select('*').eq('slate_id', slate.id),
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
      getEffectiveNow(),
    ])

    // Every open page polls this ticker, so it is the heartbeat that fills in
    // missed picks within a minute or two of first tip. Runs after the
    // response is sent; a no-op until the slate locks and once it's done.
    after(() => autoAssignIfDue(supabase, now))

    const dbGames = (dbGamesRes.data ?? []) as Game[]

    let games: LiveGame[] = []
    let source: LiveScoresResponse['source'] = 'none'

    for (const event of events ?? []) {
      const teams = eventCompetitors(event)
      if (!teams) continue
      const status = event.competitions[0].status
      const homeAbbr = teams.home.team.abbreviation
      const awayAbbr = teams.away.team.abbreviation
      if (!homeAbbr || !awayAbbr) continue
      games.push({
        id: event.id,
        homeTeam: homeAbbr,
        awayTeam: awayAbbr,
        homeScore: parseInt(teams.home.score ?? '0') || 0,
        awayScore: parseInt(teams.away.score ?? '0') || 0,
        state: status.type.state as 'pre' | 'in' | 'post',
        statusText: status.type.shortDetail ?? '',
        kickoff: event.date,
        timeTbd: event.competitions[0].timeValid === false,
        homeSeed: seedOf(teams.home),
        awaySeed: seedOf(teams.away),
        homeLogo: teams.home.team.logo ?? teams.home.team.logos?.[0]?.href ?? null,
        awayLogo: teams.away.team.logo ?? teams.away.team.logos?.[0]?.href ?? null,
        homeColor: teams.home.team.color ? `#${teams.home.team.color}` : null,
        awayColor: teams.away.team.color ? `#${teams.away.team.color}` : null,
      })
    }

    if (games.length > 0) {
      source = 'espn'
    } else if (dbGames.length > 0) {
      // No ESPN coverage (sandbox, or a slate it can't serve): show this pool's
      // own slate so the ticker still carries the schedule and any result the
      // admin has entered, instead of disappearing entirely. Logos come from
      // the teams table — only this fallback needs it, and only these teams.
      const abbrs = [...new Set(dbGames.flatMap((g) => [g.home_team, g.away_team]))]
      const { data: teams } = await supabase.from('teams').select('abbr, logo').in('abbr', abbrs)
      const teamRows = Object.fromEntries((teams ?? []).map((team) => [team.abbr, team]))
      games = dbGames.map((g) => gameFromSchedule(g, now, teamRows))
      source = 'schedule'
    }

    games.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())

    const hasLiveGames = games.some((g) => g.state === 'in')

    // The slate locks as a unit at its first tip, so picks go public as a
    // unit too — there is no longer a per-team reveal to compute.
    const revealedTeams = new Set<string>()
    if (isSlateLocked(slate, dbGames, now)) {
      for (const g of dbGames) {
        revealedTeams.add(g.home_team)
        revealedTeams.add(g.away_team)
      }
    }
    // A tipped-off ESPN game is revealed regardless, which covers a slate
    // whose locks_at is missing or whose schedule row never synced.
    for (const g of games) {
      if (g.state !== 'pre') {
        revealedTeams.add(g.homeTeam)
        revealedTeams.add(g.awayTeam)
      }
    }

    if (revealedTeams.size > 0) {
      // Pick counts for the day, excluding test accounts. The player's email
      // rides along on each pick, so this reads the day's picks and nothing
      // else — not the whole players table on every poll.
      const { data: picks } = await supabase
        .from('picks')
        .select('team, players(email)')
        .eq('slate_id', slate.id)

      const pickCounts: Record<string, number> = {}
      for (const pick of picks || []) {
        const email = (pick.players as unknown as { email: string | null } | null)?.email
        if (email && isDeliverable(email)) {
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
      headers: {
        // Cache 30s during live games, 5min otherwise
        'Cache-Control': hasLiveGames ? cacheHeader(30, 10) : cacheHeader(300, 60),
      },
    })
  } catch (err) {
    console.error('live-scores error', err)
    return NextResponse.json(EMPTY, { status: 500 })
  }
}
