import { allRows } from '@/lib/db'
import { publicPlayerLabels } from '@/lib/playerLabels'
import { NextResponse, after, type NextRequest } from 'next/server'
import { getDb, isTestMode, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline, isPickRevealed } from '@/lib/deadline'
import { isDeliverable } from '@/lib/email'
import { autoAssignIfDue } from '@/lib/autoAssign'
import { fetchDayScoreboard, eventCompetitors } from '@/lib/espn'
import { getPoolConfig, poolScope, contestFilter } from '@/lib/pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  roundDisplay,
  seedToShow,
  type CompetitionMode,
} from '@/lib/competition'
import type { Game } from '@/types'
import { loadPicksForSlates } from '@/lib/seasonData'
import { reportFailure } from '@/lib/alerts'
import { conferenceGroup } from '@/lib/teams'
import { getCachedTeamConferences, getTeamBrandDirectory } from '@/lib/sharedData'
import { brandsFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { cdnSeconds, feedCacheControl } from '@/lib/livePolling'

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
  // Given a team at lock because no pick was made. Only set once revealed.
  auto?: boolean
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
  tv: string | null
  // Region in the tournament, conference otherwise.
  group: string | null
}

export interface SweatResponse {
  // Names, logos and colors for every team on the board.
  brands?: TeamBrandDirectory
  slateNumber: number | null
  season: number | null
  /** The active competition, so the board can label itself correctly. */
  mode: CompetitionMode
  /** "Saturday, January 17" or "Second Round · Thursday". */
  periodLabel: string | null
  /** "Second Round", in tournament mode only. */
  roundLabel: string | null
  /** The slate's lock instant: first tip. */
  locksAt: string | null
  /** Entries still alive — the denominator for every "% of the field" figure. */
  aliveCount: number
  /** Entries with a stake today: alive ones, plus any already put out by
   *  today's results. Live finals count as losses here before results are
   *  graded; the official status changes only when they are. */
  entriesToday: number
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

// Room for the auto-assign run this route may kick off after responding.
export const maxDuration = 60

const EMPTY: SweatResponse = {
  slateNumber: null,
  season: null,
  mode: 'regular-season',
  periodLabel: null,
  roundLabel: null,
  locksAt: null,
  aliveCount: 0,
  entriesToday: 0,
  hasLiveGames: false,
  allRevealed: false,
  games: [],
  players: [],
  summary: { safe: 0, winning: 0, losing: 0, out: 0, notStarted: 0, hidden: 0, pending: 0, noPick: 0 },
}

// The CDN keeps a copy for up to 30 seconds before the first tip (never past
// it), 10 during games and 5 minutes once the day is done; see lib/livePolling.
// Test-mode browsers ask for ?sandbox=1, which is never stored, so a tester
// never sees the real pool's copy and the real pool never sees the sandbox.
const BEFORE_TIP_SECONDS = 30
// With no active day, check back within a minute so a newly opened one shows.
const NO_SLATE_SECONDS = 60

export async function GET(request: NextRequest) {
  try {
    const supabase = await getDb()
    const testMode = await isTestMode()
    const uncached = testMode || request.nextUrl.searchParams.has('sandbox')
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
        { headers: { 'Cache-Control': feedCacheControl(uncached ? null : NO_SLATE_SECONDS) } }
      )
    }

    const [playersRes, picksRes, dbGamesRes, events, directory] = await Promise.all([
      allRows(supabase
        .from('players')
        .select('id, full_name, email, status, elimination_slate')
        .match(contestFilter(poolScope(pool)))
        .order('full_name')),
      loadPicksForSlates<{ player_id: string; team: string; auto_assigned: boolean | null }>(supabase, [slate.id], 'player_id, team, auto_assigned').then(data => ({ data })),
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
      getTeamBrandDirectory(),
    ])

    const labels = publicPlayerLabels((playersRes.data ?? []).filter(player => isDeliverable(player.email)))
    for (const player of playersRes.data ?? []) player.full_name = labels.get(player.id) ?? player.full_name

    // Alive players sweat; players eliminated this slate stay on the board as OUT.
    const players = (playersRes.data ?? []).filter(
      (p: { email: string; status: string; elimination_slate: number | null }) =>
        p.email && isDeliverable(p.email) &&
        (p.status === 'alive' || p.elimination_slate === slate.slate_number)
    )
    const picksByPlayer: Record<string, string[]> = {}
    const autoPicks = new Set<string>()
    for (const pick of picksRes.data ?? []) {
      if (!picksByPlayer[pick.player_id]) picksByPlayer[pick.player_id] = []
      picksByPlayer[pick.player_id].push(pick.team)
      if (pick.auto_assigned) autoPicks.add(`${pick.player_id}:${pick.team}`)
    }

    const dbGames = (dbGamesRes.data ?? []) as Game[]

    // The ESPN scoreboard payload has the scores; the synced rows have the
    // bracket. Matching them on the team pair is enough — a slate never has
    // the same two teams twice.
    const metaByPair = new Map<string, Game>()
    for (const g of dbGames) metaByPair.set(`${g.away_team}@${g.home_team}`, g)
    const conferences = caps.showRegions || !dbGames.length ? {} : await getCachedTeamConferences(supabase)
    const bracketOf = (awayTeam: string, homeTeam: string) => {
      const g = metaByPair.get(`${awayTeam}@${homeTeam}`)
      return {
        tv: g?.tv ?? null,
        group: caps.showRegions ? g?.region ?? null : conferenceGroup(awayTeam, homeTeam, conferences),
        round: caps.showTournamentRounds ? roundDisplay(g?.round_label) : null,
        region: caps.showRegions ? g?.region ?? null : null,
        homeSeed: seedToShow(mode, g?.home_seed, g?.round_label),
        awaySeed: seedToShow(mode, g?.away_seed, g?.round_label),
      }
    }

    const now = await getEffectiveNow()
    // Fill in missed picks once first tip has passed — see lib/autoAssign.ts.
    after(() => autoAssignIfDue(supabase, now))
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

    const withAuto = (playerId: string, team: string, player: SweatPlayer): SweatPlayer =>
      player.team && autoPicks.has(`${playerId}:${team}`) ? { ...player, auto: true } : player

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

        return teams.map((team): SweatPlayer => withAuto(p.id, team, (() => {
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
        })()))
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
    // How long the CDN may keep this response comes from the pool's own
    // schedule, with ESPN's status where it has one, so an ESPN outage that
    // empties the board is never cached for long.
    const espnByPair = new Map(espnGames.map((game) => [`${game.awayTeam}@${game.homeTeam}`, game]))
    const schedule = dbGames.map((g) => ({
      state: espnByPair.get(`${g.away_team}@${g.home_team}`)?.state
        ?? (g.result !== 'pending' ? 'post' : !g.time_tbd && now >= new Date(g.tip_time) ? 'in' : 'pre'),
      kickoff: g.tip_time,
      timeTbd: g.time_tbd,
    }))

    return NextResponse.json(
      {
        slateNumber: slate.slate_number,
        season: slate.season_year,
        mode,
        periodLabel: period?.label ?? null,
        roundLabel: period?.roundLabel ?? null,
        locksAt: deadline?.toISOString() ?? null,
        aliveCount,
        entriesToday: players.length,
        hasLiveGames,
        allRevealed: deadlinePassed,
        games: espnGames,
        players: sweatPlayers,
        summary,
        brands: brandsFor(espnGames.flatMap((game) => [game.homeTeam, game.awayTeam]), directory),
      } satisfies SweatResponse,
      {
        headers: {
          'Cache-Control': feedCacheControl(uncached ? null : cdnSeconds(schedule, hasLiveGames, BEFORE_TIP_SECONDS)),
        },
      }
    )
  } catch (err) {
    console.error('sweat error', err)
    await reportFailure(await getDb(), { kind: 'server-error', source: 'api/sweat', message: 'api/sweat returned 500', error: err })
    return NextResponse.json(EMPTY, { status: 500 })
  }
}
