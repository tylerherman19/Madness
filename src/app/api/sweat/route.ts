import { NextResponse } from 'next/server'
import { getDb, isTestMode, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline, isPickRevealed } from '@/lib/deadline'
import { isDeliverable } from '@/lib/email'
import { fetchDayScoreboard, eventCompetitors } from '@/lib/espn'
import { getPoolConfig } from '@/lib/pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  roundDisplay,
  seedToShow,
  type CompetitionMode,
} from '@/lib/competition'
import type { Game } from '@/types'

export type SweatStatus =
  | 'won' // final, team won
  | 'winning' // live, ahead
  | 'tied' // live, tied
  | 'losing' // live, behind
  | 'lost' // final, team lost or tied (tie = elimination)
  | 'pre' // pick revealed, game not started
  | 'pick_in' // pick made but not yet revealed
  | 'pending' // no pick, deadline not passed
  | 'no_pick' // no pick, deadline passed (auto-assign / elimination territory)

export interface SweatPlayer {
  name: string
  team: string | null // null while hidden or no pick
  status: SweatStatus
}

export interface SweatGame {
  id: string
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  state: 'pre' | 'in' | 'post'
  statusText: string
  kickoff: string
  homePlayers: string[] // revealed picks only
  awayPlayers: string[]
  // Bracket context. Null outside the tournament, and null inside it for a
  // game whose round ESPN hasn't labelled.
  round: string | null
  region: string | null
  homeSeed: number | null
  awaySeed: number | null
}

export interface SweatResponse {
  slateNumber: number | null
  season: number | null
  /** The active competition, so the board can label itself correctly. */
  mode: CompetitionMode
  /** "Saturday, January 17" or "Second Round · Thursday". */
  periodLabel: string | null
  /** "Second Round", in tournament mode only. */
  roundLabel: string | null
  /** Entries still alive — the denominator for every "% of the field" figure. */
  aliveCount: number
  hasLiveGames: boolean
  allRevealed: boolean
  games: SweatGame[]
  players: SweatPlayer[]
  summary: {
    safe: number // won
    winning: number
    losing: number // losing or tied (a tie eliminates)
    out: number // lost
    notStarted: number // revealed pick, game pre
    hidden: number // pick in, not revealed
    pending: number // no pick, deadline open
    noPick: number // no pick, deadline passed
  }
}

const EMPTY: SweatResponse = {
  slateNumber: null,
  season: null,
  mode: 'regular-season',
  periodLabel: null,
  roundLabel: null,
  aliveCount: 0,
  hasLiveGames: false,
  allRevealed: false,
  games: [],
  players: [],
  summary: { safe: 0, winning: 0, losing: 0, out: 0, notStarted: 0, hidden: 0, pending: 0, noPick: 0 },
}

export async function GET() {
  try {
    const supabase = await getDb()
    const testMode = await isTestMode()
    const [{ data: slate }, pool] = await Promise.all([
      supabase
        .from('slates')
        .select('id, slate_number, slate_date, season_year, locks_at')
        .eq('is_active', true)
        .single(),
      getPoolConfig(supabase),
    ])
    const mode: CompetitionMode = pool.competition_mode
    const caps = capabilitiesFor(mode)

    if (!slate) {
      return NextResponse.json(
        { ...EMPTY, mode },
        { headers: { 'Cache-Control': testMode ? 'private, no-store' : 'public, max-age=300' } }
      )
    }

    const [playersRes, picksRes, dbGamesRes, events] = await Promise.all([
      supabase
        .from('players')
        .select('id, full_name, email, status, elimination_slate')
        .order('full_name'),
      supabase.from('picks').select('player_id, team').eq('slate_id', slate.id),
      supabase.from('games').select('*').eq('slate_id', slate.id),
      // Sandbox matchups are fabricated, so there's nothing to look up on the
      // real scoreboard — skip the network call and read sandbox.games (with
      // its admin-entered scores) instead, below.
      testMode
        ? Promise.resolve(null)
        // Null when ESPN is down or served last season's data — treated below
        // as "no ESPN games", so every revealed pick just shows as not started.
        : fetchDayScoreboard(String(slate.slate_date).replace(/-/g, ''), 10)
            .then((r) => r.events)
            .catch(() => null),
    ])

    // Alive players sweat; players eliminated this slate stay on the board as OUT.
    const players = (playersRes.data ?? []).filter(
      (p: { email: string; status: string; elimination_slate: number | null }) =>
        p.email && isDeliverable(p.email) &&
        (p.status === 'alive' || p.elimination_slate === slate.slate_number)
    )
    const picksByPlayer: Record<string, string[]> = {}
    for (const pick of picksRes.data ?? []) {
      if (!picksByPlayer[pick.player_id]) picksByPlayer[pick.player_id] = []
      picksByPlayer[pick.player_id].push(pick.team)
    }

    const dbGames = (dbGamesRes.data ?? []) as Game[]

    // The ESPN scoreboard payload has the scores; the synced rows have the
    // bracket. Matching them on the team pair is enough — a slate never has
    // the same two teams twice.
    const metaByPair = new Map<string, Game>()
    for (const g of dbGames) metaByPair.set(`${g.away_team}@${g.home_team}`, g)
    const bracketOf = (awayTeam: string, homeTeam: string) => {
      const g = metaByPair.get(`${awayTeam}@${homeTeam}`)
      return {
        round: caps.showTournamentRounds ? roundDisplay(g?.round_label) : null,
        region: caps.showRegions ? g?.region ?? null : null,
        homeSeed: seedToShow(mode, g?.home_seed, g?.round_label),
        awaySeed: seedToShow(mode, g?.away_seed, g?.round_label),
      }
    }

    const now = await getEffectiveNow()
    const deadline = slateDeadline(slate, dbGames)
    const deadlinePassed = deadline ? deadline <= now : false

    const espnGames: SweatGame[] = []
    if (testMode) {
      // Sandbox: derive game state from the simulated clock vs. each game's
      // kickoff, plus whatever scores/result an admin has entered by hand on
      // /admin/testing — a game only becomes "post" once explicitly finalized.
      for (const g of dbGames) {
        const state: 'pre' | 'in' | 'post' =
          g.result !== 'pending' ? 'post' : now >= new Date(g.tip_time) ? 'in' : 'pre'
        espnGames.push({
          id: g.id,
          homeTeam: g.home_team,
          awayTeam: g.away_team,
          homeScore: g.home_score ?? 0,
          awayScore: g.away_score ?? 0,
          state,
          statusText: state === 'post' ? 'Final (sandbox)' : state === 'in' ? 'In progress (sandbox)' : 'Not started',
          kickoff: g.tip_time,
          homePlayers: [],
          awayPlayers: [],
          ...bracketOf(g.away_team, g.home_team),
        })
      }
    } else {
      for (const event of events ?? []) {
        const teams = eventCompetitors(event)
        if (!teams) continue
        const status = event.competitions[0].status
        const homeAbbr = teams.home.team.abbreviation
        const awayAbbr = teams.away.team.abbreviation
        if (!homeAbbr || !awayAbbr) continue
        espnGames.push({
          id: event.id,
          homeTeam: homeAbbr,
          awayTeam: awayAbbr,
          homeScore: parseInt(teams.home.score ?? '0') || 0,
          awayScore: parseInt(teams.away.score ?? '0') || 0,
          state: status.type.state as 'pre' | 'in' | 'post',
          statusText: status.type.shortDetail ?? '',
          kickoff: event.date,
          homePlayers: [],
          awayPlayers: [],
          ...bracketOf(awayAbbr, homeAbbr),
        })
      }
    }

    const gameByTeam: Record<string, SweatGame> = {}
    for (const g of espnGames) {
      gameByTeam[g.homeTeam] = g
      gameByTeam[g.awayTeam] = g
    }

    const summary = { safe: 0, winning: 0, losing: 0, out: 0, notStarted: 0, hidden: 0, pending: 0, noPick: 0 }
    const sweatPlayers: SweatPlayer[] = players.flatMap(
      (p: { id: string; full_name: string }) => {
        const teams = picksByPlayer[p.id] ?? []
        if (!teams.length) {
          if (deadlinePassed) {
            summary.noPick++
            return [{ name: p.full_name, team: null, status: 'no_pick' as const }]
          }
          summary.pending++
          return [{ name: p.full_name, team: null, status: 'pending' as const }]
        }

        return teams.map((team): SweatPlayer => {
          const game = gameByTeam[team]
          // Picks are revealed the moment the slate locks, which is the same
          // instant for everyone. ESPN reporting the game as started counts
          // too, in case our stored tip time drifted.
          const revealed =
            isPickRevealed(slate, dbGames, now) || (game !== undefined && game.state !== 'pre')
          if (!revealed) {
            summary.hidden++
            return { name: p.full_name, team: null, status: 'pick_in' }
          }

          if (!game) {
            summary.notStarted++
            return { name: p.full_name, team, status: 'pre' }
          }

          const isHome = game.homeTeam === team
          if (isHome) game.homePlayers.push(p.full_name)
          else game.awayPlayers.push(p.full_name)

          if (game.state === 'pre') {
            summary.notStarted++
            return { name: p.full_name, team, status: 'pre' }
          }

          const my = isHome ? game.homeScore : game.awayScore
          const their = isHome ? game.awayScore : game.homeScore
          let status: SweatStatus
          if (game.state === 'post') {
            status = my > their ? 'won' : 'lost' // tie eliminates
            if (status === 'won') summary.safe++
            else summary.out++
          } else {
            status = my > their ? 'winning' : my < their ? 'losing' : 'tied'
            if (status === 'winning') summary.winning++
            else summary.losing++ // tied counts as danger — a tie eliminates
          }
          return { name: p.full_name, team, status }
        })
      }
    )

    const hasLiveGames = espnGames.some((g) => g.state === 'in')

    // Name the pick period the way the pool names it. The sweat board is the
    // one page people leave open all day, so the label has to match the
    // vocabulary everywhere else.
    const [period] = buildPickPeriods(
      mode,
      [
        {
          id: slate.id,
          slate_number: slate.slate_number,
          slate_date: String(slate.slate_date),
          locks_at: slate.locks_at,
        },
      ],
      dbGames.map((g) => ({ slate_id: g.slate_id, round_label: g.round_label }))
    )

    const aliveCount = players.filter((p: { status: string }) => p.status === 'alive').length

    return NextResponse.json(
      {
        slateNumber: slate.slate_number,
        season: slate.season_year,
        mode,
        periodLabel: period?.label ?? null,
        roundLabel: period?.roundLabel ?? null,
        aliveCount,
        hasLiveGames,
        allRevealed: deadlinePassed,
        games: espnGames,
        players: sweatPlayers,
        summary,
      } satisfies SweatResponse,
      {
        headers: {
          // Sandbox responses must never land in the shared CDN cache
          'Cache-Control': testMode
            ? 'private, no-store'
            : hasLiveGames
            ? 'public, max-age=30, stale-while-revalidate=10'
            : 'public, max-age=300, stale-while-revalidate=60',
        },
      }
    )
  } catch (err) {
    console.error('sweat error', err)
    return NextResponse.json(EMPTY, { status: 500 })
  }
}
