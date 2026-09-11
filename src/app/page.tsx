import Link from 'next/link'
import type { StandingRow, TeamStat, Slate, Game } from '@/types'
import { computeInsights } from '@/lib/insights'
import { getPoolConfig } from '@/lib/pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  copyFor,
  formatPeriodDate,
  weekdayOf,
  type CompetitionMode,
  type PickPeriod,
} from '@/lib/competition'
import Countdown from './components/Countdown'
import LiveTicker from './components/LiveTicker'
import SiteHeader from './components/SiteHeader'
import TeamChip from './components/TeamChip'
import {
  BurnMap,
  ChalkFigure,
  ExposureFigure,
  LeverageTable,
  OverlapFigure,
  Story,
  TrajectoryFigure,
} from './components/insights'

// Cache the server render for 60 seconds — serves ~1k concurrent users from CDN
// without hitting Supabase 1k times simultaneously. Pick deadline countdown
// updates client-side via the Countdown component regardless.
export const revalidate = 60

// A season has no fixed number of playing days, so the progress bar can't be
// "slate N of 18" any more. This is only the denominator the trajectory
// module uses to scale its projection; the header shows the date instead.
const TOTAL_SLATES_ESTIMATE = 120

async function getDashboardData() {
  try {
    const { slateDeadline, isPickRevealed } = await import('@/lib/deadline')

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let allWeeks: any[] | null = null
    let allPlayers: any[] | null = null
    let allPicks: any[] | null = null
    let allGames: any[] | null = null
    /* eslint-enable @typescript-eslint/no-explicit-any */

    {
      const { getDb } = await import('@/lib/testMode')
      const supabase = await getDb()

      // Single Promise.all with 4 queries: all slates, all players, all picks with team, all games
      const [weeksRes, playersRes, picksRes, gamesRes] = await Promise.all([
        supabase.from('slates').select('*').order('slate_number'),
        supabase.from('players').select('id, full_name, email, status, elimination_slate, elimination_reason, paid').order('full_name'),
        supabase.from('picks').select('player_id, slate_id, team'),
        supabase.from('games').select('*')
      ])
      allWeeks = weeksRes.data
      allPlayers = playersRes.data
      allPicks = picksRes.data
      allGames = gamesRes.data
    }

    if (!allPlayers) return null
    const players = allPlayers.filter((p: { email: string }) => !p.email?.endsWith('@nflsurvivor.internal'))
    const realPlayerIds = new Set(players.map((p: { id: string }) => p.id))

    const totalPaid = players.filter((p: { paid: boolean }) => p.paid).length
    const potSize = totalPaid * 25
    const alive = players.filter((p: { status: string }) => p.status === 'alive')
    const payoutPerSurvivor = alive.length > 0 ? Math.floor(potSize / alive.length) : 0

    // Find active slate from allWeeks
    const slate = (allWeeks || []).find((w: { is_active: boolean }) => w.is_active) || null

    // The pool's own configuration decides how all of this is presented. It
    // is read once here and threaded down — no component re-derives the mode.
    const pool = await getPoolConfig()
    const mode: CompetitionMode = pool.competition_mode

    // Everything derived below is scoped to the season currently being played
    // (season_year), read off the active slate like getSignupCutoff does — a
    // future season synced early, or last season's leftovers, must not get
    // folded into this season's carnage cards, survival curve, or team stats.
    // With no active slate there is nothing being played, so fall back to the
    // newest season_year present.
    const seasonAnchor =
      slate ||
      (allWeeks || [])
        .slice()
        .sort((a: { season_year: number }, b: { season_year: number }) => b.season_year - a.season_year)[0] ||
      null

    const seasonWeeks = (allWeeks || []).filter(
      (w: { season_year: number }) => !seasonAnchor || w.season_year === seasonAnchor.season_year
    )
    const seasonWeekIds = new Set<string>(seasonWeeks.map((w: { id: string }) => w.id))
    const seasonPicks = (allPicks || []).filter(
      (p: { slate_id: string; player_id: string }) => seasonWeekIds.has(p.slate_id) && realPlayerIds.has(p.player_id)
    )

    let currentPicks: Record<string, string> = {}
    // Subset of currentPicks that can be shown publicly — all of them, once
    // the slate locks at its first tip.
    const revealedPicks: Record<string, string> = {}
    let nextDeadline: string | null = null
    let nextDeadlineFormatted: string | null = null
    let picksRevealed = false

    if (slate) {
      // Filter picks for current slate from allPicks
      const picksData = (allPicks || []).filter((p: { slate_id: string }) => p.slate_id === slate.id)
      if (picksData) {
        currentPicks = Object.fromEntries(
          picksData
            .filter((p: { player_id: string }) => realPlayerIds.has(p.player_id))
            .map((p: { player_id: string; team: string }) => [p.player_id, p.team])
        )
      }

      // Filter games for current slate from allGames
      const gamesData = (allGames || []).filter((g: { slate_id: string }) => g.slate_id === slate.id)
      if (gamesData) {
        const { getEffectiveNow } = await import('@/lib/testMode')
        const now = await getEffectiveNow()
        const slateLockTime = slateDeadline(slate, gamesData)
        if (slateLockTime && slateLockTime > now) {
          nextDeadline = slateLockTime.toISOString()
          nextDeadlineFormatted = slateLockTime.toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        }
        picksRevealed = slateLockTime ? slateLockTime <= now : false

        // The slate reveals as a unit at its first tip, so this is one
        // decision for every pick rather than a per-team lookup.
        if (isPickRevealed(slate, gamesData, now)) {
          for (const [playerId, team] of Object.entries(currentPicks)) {
            revealedPicks[playerId] = team
          }
        }
      }
    }

    // Pick periods: the season's playing days, labelled for the active
    // competition. Regular season reads "Saturday, January 24"; the
    // tournament reads "First Round · Thursday".
    const periods = buildPickPeriods(
      mode,
      seasonWeeks.map((w: { id: string; slate_number: number; slate_date: string; locks_at: string | null }) => ({
        id: w.id,
        slate_number: w.slate_number,
        slate_date: String(w.slate_date),
        locks_at: w.locks_at,
      })),
      (allGames || []).map((g: { slate_id: string; round_label: string | null }) => ({
        slate_id: g.slate_id,
        round_label: g.round_label,
      }))
    )
    const currentPeriod = slate ? periods.find((p) => p.id === slate.id) ?? null : null
    const periodByNumber: Record<number, PickPeriod> = {}
    for (const p of periods) periodByNumber[p.number] = p

    // Today's slate facts, for the "Today's Pool" strip.
    const slateGames: Game[] = slate
      ? ((allGames || []).filter((g: { slate_id: string }) => g.slate_id === slate.id) as Game[])
      : []
    const announcedTips = slateGames
      .filter((g) => !g.time_tbd && !isNaN(new Date(g.tip_time).getTime()))
      .map((g) => new Date(g.tip_time).getTime())
      .sort((a, b) => a - b)
    const firstTip = announcedTips.length > 0 ? new Date(announcedTips[0]).toISOString() : null

    // "TODAY" only when the active slate really is today in Central — the
    // pool's own timezone. Every other day gets its own name.
    const centralToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const slateIsToday = slate ? String(slate.slate_date).slice(0, 10) === centralToday : false

    const { getTeamAbbrs } = await import('@/lib/teams')
    const { getDb } = await import('@/lib/testMode')
    const teamUniverse = await getTeamAbbrs(await getDb())

    // Count slates survived per player from this season's picks (including current slate)
    const weeksSurvivedByPlayer: Record<string, number> = {}
    // Sum of the seeds each player has taken — the tiebreak when more than
    // one survivor is left. Regular-season picks carry no seed, so this stays
    // at zero until the bracket is set.
    const seedTotalByPlayer: Record<string, number> = {}
    for (const pick of seasonPicks) {
      weeksSurvivedByPlayer[pick.player_id] = (weeksSurvivedByPlayer[pick.player_id] || 0) + 1
      seedTotalByPlayer[pick.player_id] =
        (seedTotalByPlayer[pick.player_id] || 0) + (pick.seed ?? 0)
    }

    const standings: StandingRow[] = players.map(
      (p: { id: string; full_name: string; status: string; elimination_reason: string | null; elimination_slate: number | null }) => ({
        player_id: p.id,
        full_name: p.full_name,
        status: p.status as 'alive' | 'eliminated',
        slates_survived: weeksSurvivedByPlayer[p.id] || 0,
        seed_total: seedTotalByPlayer[p.id] || 0,
        current_pick: currentPicks[p.id] || null,
        pick_locked: !!currentPicks[p.id],
        pick_revealed: !!revealedPicks[p.id],
        elimination_reason: p.elimination_reason,
        elimination_slate: p.elimination_slate,
      })
    )

    standings.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
      return b.slates_survived - a.slates_survived
    })

    // Filter picks to exclude current slate for team stats
    const allPicksWithTeam = seasonPicks.filter((p: { slate_id: string }) => !slate || p.slate_id !== slate.id)

    const teamMap: Record<string, { times_picked: number; wins: number; eliminations: number }> = {}
    if (allPicksWithTeam) {
      const winnersByWeek: Record<string, string[]> = {}
      for (const g of allGames || []) {
        if (g.result === 'home_win') winnersByWeek[g.slate_id] = [...(winnersByWeek[g.slate_id] || []), g.home_team]
        else if (g.result === 'away_win') winnersByWeek[g.slate_id] = [...(winnersByWeek[g.slate_id] || []), g.away_team]
      }
      for (const pick of allPicksWithTeam) {
        if (!teamMap[pick.team]) teamMap[pick.team] = { times_picked: 0, wins: 0, eliminations: 0 }
        teamMap[pick.team].times_picked++
        const winners = winnersByWeek[pick.slate_id] || []
        if (winners.includes(pick.team)) teamMap[pick.team].wins++
        else if (winners.length > 0) teamMap[pick.team].eliminations++
      }
    }

    const teamStats: TeamStat[] = Object.entries(teamMap)
      .map(([team, stats]) => ({
        team,
        times_picked: stats.times_picked,
        win_rate: stats.times_picked > 0 ? stats.wins / stats.times_picked : 0,
        eliminations_caused: stats.eliminations,
      }))
      .sort((a, b) => b.times_picked - a.times_picked)

    const picksMade = alive.filter((p: { id: string }) => currentPicks[p.id]).length
    const picksPending = alive.length - picksMade

    // Everything the editorial modules need is already in hand — the insight
    // layer is a pure function over it, and only ever sees revealed picks for
    // the current slate.
    const insights = computeInsights({
      players,
      slates: seasonWeeks
        .slice()
        .sort((a: { slate_number: number }, b: { slate_number: number }) => a.slate_number - b.slate_number),
      picks: seasonPicks,
      games: allGames || [],
      currentSlate: slate,
      revealedCurrentPicks: revealedPicks,
      potSize,
      totalWeeks: TOTAL_SLATES_ESTIMATE,
      teamUniverse,
    })

    return {
      pool,
      mode,
      periods,
      currentPeriod,
      periodByNumber,
      slateIsToday,
      gameCount: slateGames.length,
      firstTip,
      slate: slate as Slate | null,
      standings,
      teamStats,
      potSize,
      payoutPerSurvivor,
      aliveCount: alive.length,
      eliminatedCount: players.length - alive.length,
      totalPlayers: players.length,
      nextDeadline,
      nextDeadlineFormatted,
      picksRevealed,
      picksMade,
      picksPending,
      insights,
    }
  } catch {
    return null
  }
}

export default async function DashboardPage() {
  const { haveSignupsClosed } = await import('@/lib/season')
  const [data, signupsClosed] = await Promise.all([getDashboardData(), haveSignupsClosed()])

  const aliveRows = data?.standings.filter((r) => r.status === 'alive') ?? []
  const elimRows = data?.standings.filter((r) => r.status === 'eliminated') ?? []
  const insights = data?.insights

  // One read of the pool's format, threaded through the whole page. If the
  // dashboard query failed we still need a mode to render the header with.
  const mode: CompetitionMode = data?.mode ?? (await getPoolConfig()).competition_mode
  const caps = capabilitiesFor(mode)
  const copy = copyFor(mode)
  const period = data?.currentPeriod ?? null

  const { eyebrow, headline, subhead } = mastheadFor({
    mode,
    period,
    slateIsToday: data?.slateIsToday ?? false,
    seasonYear: data?.slate?.season_year ?? null,
    gameCount: data?.gameCount ?? 0,
    aliveCount: data?.aliveCount ?? 0,
  })

  const rules = buildRules(mode, copy, data?.pool?.tiebreaker ?? 'seed-total')

  // The editorial figures label their x-axis with pick periods, not week
  // numbers — the same vocabulary the rest of the page uses.
  const periodLabels: Record<number, string> = {}
  for (const p of data?.periods ?? []) periodLabels[p.number] = p.shortLabel

  return (
    <div style={{ background: 'var(--cream)', minHeight: '100vh' }}>
      {/* Header */}
      <SiteHeader signupsClosed={signupsClosed} mode={mode} />

      {/* Live scores ticker — client component, polls independently of cached server render */}
      <LiveTicker
        slateNumber={data?.slate?.slate_number}
        season={data?.slate?.season_year}
        label={period?.roundLabel ?? (period ? formatPeriodDate(period.date) : null)}
      />

      {data && data.aliveCount === 1 && aliveRows.length === 1 && (
        <div style={{ background: 'var(--dark)', borderBottom: '4px solid var(--green)' }}>
          <div className="mx-auto max-w-5xl px-4 py-10 text-center">
            <p className="eyebrow mb-2" style={{ color: 'var(--green)' }}>Survivor Champion</p>
            <p className="font-display text-7xl sm:text-8xl" style={{ color: 'var(--cream)' }}>{aliveRows[0].full_name.toUpperCase()}</p>
            <p className="mt-3 eyebrow" style={{ color: 'var(--green)' }}>Winner Takes ${data.potSize}</p>
          </div>
        </div>
      )}

      {!data ? (
        <main className="mx-auto max-w-5xl px-4 py-24 text-center">
          <p className="font-display text-6xl" style={{ color: 'var(--dark)' }}>POOL SETUP IN PROGRESS</p>
          <p className="mt-4 eyebrow">Check back soon</p>
        </main>
      ) : (
        <main className="mx-auto max-w-5xl px-4 pb-4">
          {/* Masthead: the pick period and the deadline. Regular season leads
              with the day, because the day is the unit of play; the tournament
              leads with the round, because that is what everyone is talking
              about. Same layout either way — the product should still read as
              MADNESS. */}
          <div className="pt-9 pb-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
              <div className="min-w-0">
                <p className="eyebrow" style={{ color: 'var(--red)' }}>{eyebrow}</p>
                <h1 className="mt-1.5 font-display text-6xl sm:text-7xl leading-[0.88]" style={{ color: 'var(--dark)' }}>
                  {headline}
                </h1>
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <span className="eyebrow">{subhead}</span>
                  {!caps.showTournamentRounds && data.slate && (
                    <span className="hidden sm:block h-1.5 w-40 rounded-full overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
                      <span className="block h-full rounded-full" style={{ background: 'var(--dark)', width: `${Math.min(100, ((data.slate?.slate_number ?? 0) / TOTAL_SLATES_ESTIMATE) * 100)}%` }} />
                    </span>
                  )}
                </div>
              </div>
              {data.nextDeadline && (
                <div className="card px-5 py-4 sm:min-w-[240px] shrink-0" style={{ borderColor: 'var(--border-strong)' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="pill-dot" style={{ background: 'var(--red)' }} />
                    <p className="eyebrow" style={{ color: 'var(--red)' }}>Pick Deadline</p>
                  </div>
                  <p className="font-bold text-[15px]" style={{ color: 'var(--dark)' }}>{data.nextDeadlineFormatted}</p>
                  <Countdown deadline={data.nextDeadline} />
                </div>
              )}
            </div>
          </div>

          {/* Scoreboard: the four numbers, set as a ruled strip rather than four boxes */}
          <div className="card grid grid-cols-2 sm:grid-cols-5 overflow-hidden">
            <Figure value={data.aliveCount} label="Still Alive" accent="var(--green)" />
            <Figure value={data.eliminatedCount} label="Eliminated" accent="var(--red)" />
            <Figure value={data.gameCount} label={caps.showTournamentRounds ? 'Tournament Games' : "Today's Games"} accent="var(--ink)" />
            <Figure value={`$${data.potSize}`} label="Pot Size" accent="var(--ink)" />
            <Figure
              value={data.aliveCount > 0 && data.aliveCount < 20 ? `$${data.payoutPerSurvivor}` : `${data.picksMade}/${data.aliveCount}`}
              label={
                data.aliveCount > 0 && data.aliveCount < 20
                  ? data.aliveCount === 1 ? 'Winner Takes' : 'Split Estimate'
                  : 'Picks In'
              }
              accent="var(--ink)"
            />
          </div>

          {insights?.exposure && (
            <section className="pt-10">
              <ExposureFigure data={insights.exposure} />
            </section>
          )}

          {insights?.leverage && (
            <Story
              kicker="Leverage"
              lede={insights.leverage.headline}
              deck={insights.leverage.deck}
              method="Best case is the field that would remain if this pick wins and every other public pick loses. Dollar figures split the current pot across that field."
            >
              <LeverageTable data={insights.leverage} />
            </Story>
          )}

          {/* ---- Standings ---- */}
          <Section id="standings" title="Standings" className="pt-10">
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    <th className="py-2.5 pl-4 text-left eyebrow w-full">Player</th>
                    <th className="py-2.5 px-4 text-left eyebrow hidden sm:table-cell whitespace-nowrap">Status</th>
                    <th className="py-2.5 pl-4 pr-4 text-left eyebrow whitespace-nowrap">{data.currentPeriod ? `${data.currentPeriod.shortLabel} Pick` : 'Pick'}</th>
                  </tr>
                </thead>
                <tbody>
                  {aliveRows.length > 0 && (
                    <tr>
                      <td colSpan={3} className="pt-4 pb-1.5 pl-4">
                        <span className="pill pill-alive"><span className="pill-dot" />{aliveRows.length} Still Alive</span>
                      </td>
                    </tr>
                  )}
                  {aliveRows.map((row) => (
                    <tr key={row.player_id} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="py-3 pl-4 font-bold" style={{ color: 'var(--dark)' }}>{row.full_name}</td>
                      <td className="py-3 px-4 hidden sm:table-cell">
                        <span className="pill pill-alive"><span className="pill-dot" />Alive</span>
                      </td>
                      <td className="py-3 pl-4 pr-4">
                        {row.current_pick ? (
                          row.pick_revealed ? (
                            <TeamChip team={row.current_pick} size={18} />
                          ) : (
                            <span className="pill pill-alive">✓ Pick In</span>
                          )
                        ) : (
                          <span className="text-xs italic" style={{ color: 'var(--red)' }}>no pick yet</span>
                        )}
                      </td>
                    </tr>
                  ))}

                  {elimRows.length > 0 && (
                    <tr>
                      <td colSpan={3} className="pt-6 pb-1.5 pl-4">
                        <span className="pill pill-out">♦ {elimRows.length} Eliminated</span>
                      </td>
                    </tr>
                  )}
                  {elimRows.map((row) => {
                    const ew = (row as StandingRow & { elimination_slate?: number | null }).elimination_slate
                    return (
                      <tr key={row.player_id} className="border-t" style={{ borderColor: 'var(--border)', opacity: 0.65 }}>
                        <td className="py-2.5 pl-4 text-sm" style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{row.full_name}</td>
                        <td className="py-2.5 px-4 hidden sm:table-cell">
                          <span className="pill pill-out">Out{ew ? ` · ${data.periodByNumber[ew]?.shortLabel ?? `#${ew}`}` : ''}</span>
                        </td>
                        <td className="py-2.5 pl-4 pr-4 text-xs" style={{ color: 'var(--muted)' }}>
                          {row.elimination_reason ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ---- The season so far ---- */}
          {(insights?.trajectory || insights?.chalk || insights?.scarcity || insights?.overlap) && (
            <div className="pt-12">
              <hr className="story-rule" />
              <p className="eyebrow mt-4">The season so far</p>
            </div>
          )}

          {insights?.trajectory && (
            <Story
              kicker="Attrition"
              lede={insights.trajectory.headline}
              deck={insights.trajectory.deck}
              method="The dashed projection compounds the season's average weekly survival rate forward. It is an extrapolation of this pool's own results, not a forecast of any game."
            >
              <TrajectoryFigure data={insights.trajectory} periodLabels={periodLabels} />
            </Story>
          )}

          {insights?.chalk && (
            <Story
              kicker="The crowd"
              lede={insights.chalk.headline}
              deck={insights.chalk.deck}
              method="The crowd pick is the most-selected team in a completed slate, across every entry that was still alive to make one."
            >
              <ChalkFigure data={insights.chalk} periodLabels={periodLabels} />
            </Story>
          )}

          {insights?.scarcity && (
            <Story
              kicker="What's left on the board"
              lede={insights.scarcity.headline}
              deck={insights.scarcity.deck}
              method="Counts cover surviving entries only. A team is spent for a player the moment their pick on it locks — you can't pick the same team twice all season."
            >
              <BurnMap data={insights.scarcity} />
            </Story>
          )}

          {insights?.overlap && (
            <Story
              kicker="Divergence"
              lede={insights.overlap.headline}
              deck={insights.overlap.deck}
              method="Overlap is the share of two survivors' unused teams that is common to both. Boards that overlap heavily tend to live and die together in later slates."
            >
              <OverlapFigure data={insights.overlap} />
            </Story>
          )}

          {/* Team ledger — how each team has actually treated the people who picked it */}
          {data.teamStats.length > 0 && (
            <Section title="Team ledger">
              <div className="card overflow-hidden">
                {/* Every cell carries its own horizontal padding: .eyebrow's 0.18em
                    tracking makes these headers wide enough that with no gap they
                    ran together into one "TEAM TIMES PICKED WIN RATE ELIMINATIONS"
                    string on a phone. Short labels keep four tracked columns inside
                    a 390px viewport, and the numeric columns are right-aligned so
                    the figures sit under their own header instead of hugging the
                    column to their left. */}
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--surface-sunken)' }}>
                      <th className="py-2.5 pl-4 pr-3 text-left eyebrow">Team</th>
                      <th className="py-2.5 px-3 text-right eyebrow whitespace-nowrap">Picks</th>
                      <th className="py-2.5 px-3 text-right eyebrow whitespace-nowrap">Win Rate</th>
                      <th className="py-2.5 pl-3 pr-4 text-right eyebrow whitespace-nowrap">Outs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.teamStats.map((stat) => (
                      <tr key={stat.team} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                        <td className="py-2.5 pl-4 pr-3"><TeamChip team={stat.team} showName size={18} /></td>
                        <td className="py-2.5 px-3 text-right tnum" style={{ color: 'var(--dark)' }}>{stat.times_picked}</td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 rounded-full overflow-hidden hidden sm:block" style={{ background: 'var(--surface-sunken)', height: 6 }}>
                              <div className="h-full rounded-full" style={{ width: `${stat.win_rate * 100}%`, background: stat.win_rate >= 0.6 ? 'var(--green)' : stat.win_rate >= 0.4 ? 'var(--dark)' : 'var(--red)' }} />
                            </div>
                            <span className="font-semibold tnum" style={{ color: stat.win_rate >= 0.6 ? 'var(--green)' : stat.win_rate >= 0.4 ? 'var(--dark)' : 'var(--red)' }}>
                              {(stat.win_rate * 100).toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 pl-3 pr-4 text-right tnum" style={{ color: 'var(--dark)' }}>{stat.eliminations_caused}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="method">Completed slates only. Win rate is how often a team delivered for the people who picked it; Outs is how many entries it ended.</p>
            </Section>
          )}

          {/* Rules */}
          <Section id="rules" title="How It Works">
            <div className="card p-5 sm:p-6 grid sm:grid-cols-2 gap-x-10 gap-y-4">
              {rules.map((text, i) => (
                <Rule key={i} n={String(i + 1)} text={text} />
              ))}
            </div>
          </Section>
        </main>
      )}

      {/* Footer */}
      <footer style={{ background: 'var(--dark)' }} className="mt-10">
        <div className="mx-auto max-w-5xl px-4 py-6 flex items-center justify-between">
          <span className="text-xs tracking-widest uppercase text-gray-500">$25 Entry · Venmo @griffinsell</span>
          <div className="flex items-center gap-6">
            {!signupsClosed && (
              <Link href="/signup" className="text-xs tracking-widest uppercase text-gray-500 hover:text-white transition-colors">Sign Up</Link>
            )}
            <Link href="/admin/login" className="text-xs tracking-widest uppercase text-gray-500 hover:text-white transition-colors">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Section({ id, title, children, className }: { id?: string; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`pt-10 ${className ?? ''}`}>
      <p className="eyebrow mb-3">{title}</p>
      {children}
    </section>
  )
}

function Figure({ value, label, accent }: { value: string | number; label: string; accent: string }) {
  return (
    <div className="px-4 py-4 sm:px-5 border-t sm:border-t-0 sm:border-l first:border-t-0 sm:first:border-l-0 [&:nth-child(2)]:border-t-0 sm:[&:nth-child(2)]:border-l" style={{ borderColor: 'var(--border)' }}>
      <p className="figure-num text-4xl sm:text-5xl" style={{ color: accent }}>{value}</p>
      <p className="mt-2 eyebrow">{label}</p>
    </div>
  )
}

function Rule({ n, text }: { n: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex items-center justify-center shrink-0 rounded-full font-bold text-xs" style={{ background: 'var(--red-tint)', color: 'var(--red)', width: 22, height: 22 }}>{n}</span>
      <span className="text-sm pt-0.5" style={{ color: 'var(--dark)' }}>{text}</span>
    </div>
  )
}


// ---------------------------------------------------------------- masthead

interface Masthead {
  eyebrow: string
  headline: string
  subhead: string
}

// The one place the two competitions diverge on the front page.
//
// Regular season: the day is the story. "TODAY / Saturday's Survivor Slate".
// March Madness: the round is the story, with the field size behind it.
// "FIRST ROUND / Thursday, March 18 / 32 games · 46 survivors".
function mastheadFor({
  mode,
  period,
  slateIsToday,
  seasonYear,
  gameCount,
  aliveCount,
}: {
  mode: CompetitionMode
  period: PickPeriod | null
  slateIsToday: boolean
  seasonYear: number | null
  gameCount: number
  aliveCount: number
}): Masthead {
  const caps = capabilitiesFor(mode)

  if (!period) {
    return {
      eyebrow: seasonYear ? `${seasonYear} Season` : 'MADNESS',
      headline: caps.showTournamentRounds ? 'BRACKET NOT SET' : 'NO ACTIVE GAME DAY',
      subhead: caps.showTournamentRounds
        ? 'Rounds appear once the tournament field is synced'
        : 'The next slate appears once games are scheduled',
    }
  }

  if (caps.showTournamentRounds && period.roundLabel) {
    // "32 games · 46 survivors" — the tournament header the product is built
    // around, driven by real data rather than a fixed bracket shape.
    const counts = [
      gameCount > 0 ? `${gameCount} game${gameCount === 1 ? '' : 's'}` : null,
      `${aliveCount} survivor${aliveCount === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      eyebrow: seasonYear ? `${seasonYear} Tournament` : 'Tournament',
      headline: period.roundLabel.toUpperCase(),
      subhead: `${formatPeriodDate(period.date)} · ${counts}`,
    }
  }

  const weekday = weekdayOf(period.date)
  return {
    eyebrow: slateIsToday ? 'Today' : `${copyFor(mode).periodNoun} ${period.number}`,
    headline: slateIsToday
      ? "TODAY'S SURVIVOR SLATE"
      : `${weekday.toUpperCase()}'S SURVIVOR SLATE`,
    subhead: formatPeriodDate(period.date),
  }
}

// House rules, phrased for the competition actually being played and for the
// tiebreak the administrator configured. A regular-season pool never mentions
// seeds; a tournament pool never claims "all season".
function buildRules(
  mode: CompetitionMode,
  copy: ReturnType<typeof copyFor>,
  tiebreaker: string
): string[] {
  const tournament = capabilitiesFor(mode).showTournamentRounds

  const endgame =
    tiebreaker === 'most-survived'
      ? 'Last one standing wins. If more than one survives, the entry that lasted longest takes it.'
      : tiebreaker === 'none'
      ? 'Last one standing wins. If more than one survives, they split the pot.'
      : tournament
      ? copy.endgameRule
      : 'Last one standing wins.'

  return [
    'Pay $25 entry via Venmo to @griffinsell.',
    tournament
      ? 'Every tournament game day, pick one team to win.'
      : 'Every day there are games, pick one team to win.',
    copy.reuseRule,
    "Your team wins, you survive. Loses and you're out.",
    'Picks lock when the first game of the day tips off — all of them, at once.',
    "Miss the lock and you're auto-assigned a team from the day's last game. If every team on the slate is already used, you're eliminated.",
    endgame,
  ]
}
