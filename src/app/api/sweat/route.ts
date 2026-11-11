import { allRows } from '@/lib/db'
import { publicPlayerLabels } from '@/lib/playerLabels'
import { NextResponse, type NextRequest } from 'next/server'
import { getDb, isTestMode, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline, isPickRevealed } from '@/lib/deadline'
import { isDeliverable } from '@/lib/email'
import { fetchDayScoreboard, displayStateOf, resultOf, scheduledEventSides } from '@/lib/espn'
import { getPoolConfig } from '@/lib/pool'
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
import { ambiguousAbbreviations, conferenceGroup } from '@/lib/teams'
import { getCachedTeamConferences, getTeamBrandDirectory } from '@/lib/sharedData'
import { brandsFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { cdnSeconds, feedCacheControl } from '@/lib/livePolling'
import { revealCacheSeconds, sandboxRedirect } from '@/lib/feedRules'

export type SweatStatus =
  | 'won' // final, team won
  | 'winning' // live, ahead
  | 'tied' // live, tied
  | 'losing' // live, behind
  | 'lost' // final, team lost
  | 'pre' // pick revealed, game not started (or postponed/unresolved)
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
   *  graded; the official status changes only when they are. A game ESPN has
   *  not definitively finished (postponed, cancelled, no clear winner) is
   *  never shown as final. */
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
// it, nor past the reveal), 10 during games and 5 minutes once the day is
// done; see lib/livePolling. The response is the same for every visitor:
// other entries' picks appear only once the stored lock has passed
// (isPickRevealed), and a viewer's own picks come from the page, not here.
// Test-mode browsers ask for ?sandbox=1, which is never stored, so a tester
// never sees the real pool's copy and the real pool never sees the sandbox.
// Outside test mode that parameter only redirects to the shared URL.
const BEFORE_TIP_SECONDS = 30
// With no active day, check back within a minute so a newly opened one shows.
const NO_SLATE_SECONDS = 60

export async function GET(request: NextRequest) {
  try {
    const testMode = await isTestMode()
    const redirect = sandboxRedirect(request.nextUrl, testMode)
    if (redirect) return redirect
    const supabase = await getDb()
    const uncached = testMode
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

    if (dbGamesRes.error) throw dbGamesRes.error
    const dbGames = (dbGamesRes.data ?? []) as Game[]

    // The ESPN scoreboard payload has the scores; the synced rows have the
    // bracket and the teams picks refer to. Events are matched to stored
    // games by ESPN event id, never by abbreviation.
    const conferences = caps.showRegions || !dbGames.length ? {} : await getCachedTeamConferences(supabase)
    const bracketOf = (g: Game | undefined, awayTeam: string, homeTeam: string) => {
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
    const deadline = slateDeadline(slate, dbGames)
    // The one reveal rule: the stored lock has passed. ESPN reporting a game
    // as started, postponed or finished never reveals anyone's pick.
    const revealed = isPickRevealed(slate, dbGames, now)

    const espnGames: SweatGame[] = []
    // Winning team abbreviation per definitively final game.
    const finalWinner = new Map<string, string>()
    if (testMode) {
      // Sandbox: derive game state from the simulated clock vs. each game's
      // kickoff, plus whatever scores/result an admin has entered by hand on
      // /admin/testing — a game only becomes "post" once explicitly finalized.
      for (const g of dbGames) {
        const state: 'pre' | 'in' | 'post' =
          g.result !== 'pending' && g.result !== 'void' ? 'post' : now >= new Date(g.tip_time) && g.result !== 'void' ? 'in' : 'pre'
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
          ...bracketOf(g, g.away_team, g.home_team),
        })
        if (g.result === 'home_win') finalWinner.set(g.id, g.home_team)
        else if (g.result === 'away_win') finalWinner.set(g.id, g.away_team)
      }
    } else {
      const scheduled = new Map(dbGames.map((game) => [game.espn_event_id, game]))
      for (const event of events ?? []) {
        const stored = scheduled.get(event.id)
        // Oriented to the stored game; null when the teams no longer match.
        const sides = stored ? scheduledEventSides(stored, event) : null
        if (!stored || !sides) continue
        const status = event.competitions[0].status
        // A postponed or cancelled game arrives as 'post' with 0–0; it shows
        // as not started rather than as a final both sides lost.
        const state = displayStateOf(event)
        const unresolved = status.type.state === 'post' && state !== 'post'
        const result = state === 'post' ? resultOf(event) : 'pending'
        espnGames.push({
          id: event.id,
          homeTeam: stored.home_team,
          awayTeam: stored.away_team,
          homeScore: parseInt(sides.home.score ?? '0') || 0,
          awayScore: parseInt(sides.away.score ?? '0') || 0,
          state,
          // An unresolved 'post' has no tip to wait for. "TBD" is what the
          // board shows for it and keeps it from counting as about to go live
          // in the CDN lifetime and the board's own polling.
          statusText: unresolved ? `${status.type.shortDetail || 'Postponed'} · TBD` : status.type.shortDetail ?? '',
          kickoff: event.date,
          homePlayers: [],
          awayPlayers: [],
          ...bracketOf(stored, stored.away_team, stored.home_team),
        })
        if (result !== 'pending') {
          const espnHomeWon = result === 'home_win'
          finalWinner.set(event.id, espnHomeWon !== sides.flipped ? stored.home_team : stored.away_team)
        }
      }
    }

    // A team abbreviation shared by two games on the day cannot say which one
    // a pick means, so such a pick is shown without a game rather than guessed.
    const ambiguous = ambiguousAbbreviations(dbGames)
    const gameByTeam: Record<string, SweatGame> = {}
    for (const g of espnGames) {
      if (!ambiguous.has(g.homeTeam)) gameByTeam[g.homeTeam] = g
      if (!ambiguous.has(g.awayTeam)) gameByTeam[g.awayTeam] = g
    }

    const withAuto = (playerId: string, team: string, player: SweatPlayer): SweatPlayer =>
      player.team && autoPicks.has(`${playerId}:${team}`) ? { ...player, auto: true } : player

    const summary = { safe: 0, winning: 0, losing: 0, out: 0, notStarted: 0, hidden: 0, pending: 0, noPick: 0 }
    const sweatPlayers: SweatPlayer[] = players.flatMap(
      (p: { id: string; full_name: string }) => {
        const teams = picksByPlayer[p.id] ?? []
        if (!teams.length) {
          if (revealed) {
            summary.noPick++
            return [{ name: p.full_name, team: null, status: 'no_pick' as const }]
          }
          summary.pending++
          return [{ name: p.full_name, team: null, status: 'pending' as const }]
        }

        return teams.map((team): SweatPlayer => withAuto(p.id, team, (() => {
          const game = gameByTeam[team]
          // Picks are revealed the moment the slate locks, which is the same
          // instant for everyone.
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
            // 'post' only ever means a definitive final (displayStateOf).
            status = finalWinner.get(game.id) === team ? 'won' : 'lost'
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
    const espnById = new Map(espnGames.map((game) => [game.id, game]))
    const schedule = dbGames.map((g) => ({
      state: espnById.get(testMode ? g.id : g.espn_event_id)?.state
        ?? (g.result !== 'pending' ? 'post' : !g.time_tbd && now >= new Date(g.tip_time) ? 'in' : 'pre'),
      kickoff: g.tip_time,
      timeTbd: g.time_tbd || Boolean(espnById.get(testMode ? g.id : g.espn_event_id)?.statusText.endsWith(' · TBD')),
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
        allRevealed: revealed,
        games: espnGames,
        players: sweatPlayers,
        summary,
        brands: brandsFor(espnGames.flatMap((game) => [game.homeTeam, game.awayTeam]), directory),
      } satisfies SweatResponse,
      {
        headers: {
          'Cache-Control': feedCacheControl(uncached ? null : revealCacheSeconds(
            cdnSeconds(schedule, hasLiveGames, BEFORE_TIP_SECONDS, now.getTime()), revealed, deadline, now)),
        },
      }
    )
  } catch (err) {
    console.error('sweat error', err)
    await reportFailure(await getDb(), { kind: 'server-error', source: 'api/sweat', message: 'api/sweat returned 500', error: err })
    return NextResponse.json(EMPTY, { status: 500 })
  }
}
