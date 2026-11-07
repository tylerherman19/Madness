import { Suspense } from 'react'
import Link from 'next/link'
import { pageMetadata } from '@/lib/site'
import { getContestCore, getContestStandings, preloadContestStandings, type ContestCore } from '@/lib/dashboard'
import { haveSignupsClosedCached } from '@/lib/season'
import { getSession } from '@/lib/session'
import { getPoolConfig } from '@/lib/pool'
import { getEffectiveNow } from '@/lib/testMode'
import { slateDeadline } from '@/lib/deadline'
import { loadMyPicks, type MyPick } from '@/lib/myEntry'
import { buildTimeline } from '@/lib/timeline'
import { brandFor } from '@/lib/teamBrand'
import { capabilitiesFor } from '@/lib/competition'
import { dayDate, eventLabel, pickDayTitle, tipTime } from '@/lib/poolTheme'
import PoolShell from '../components/PoolShell'
import ContestRefresh from '../components/ContestRefresh'
import LockCountdown from '../components/LockCountdown'
import TeamLogo from '../components/TeamLogo'
import StandingsTable from '../components/StandingsTable'
import { StandingsTableSkeleton } from '../components/PageSkeletons'
import RulesSection from '../components/RulesSection'
import SurvivalTimeline from '../components/SurvivalTimeline'
import ScrollToHash from '../components/ScrollToHash'
import { buildStandingsRows } from '@/lib/standingsRows'
import { pickStateOf } from '@/lib/viewerState'
import type { StandingRow } from '@/types'
import s from '../components/pp.module.css'

// Signed-in players see their own entry here, so the page renders per request.
export const dynamic = 'force-dynamic'

export const metadata = pageMetadata('Today', 'Today in the Pick and Pray college basketball survivor pool.', '/', true)

export default async function Today() {
  preloadContestStandings()
  // Your own picks are read as soon as the session is known, alongside the
  // pool's data rather than after it.
  const sessionRead = getSession()
  const [data, closed, session, allMyPicks] = await Promise.all([
    getContestCore(),
    haveSignupsClosedCached(),
    sessionRead,
    sessionRead.then((current) => (current ? loadMyPicks(current.player_id) : [])),
  ])
  // The standings started loading with everything else. When they are
  // already in hand — the usual, cached case — they render with the page;
  // only when they are still loading does the table stream in behind its
  // placeholder.
  const standingsRead = data ? getContestStandings(data) : Promise.resolve(null)
  const ready = await Promise.race([
    standingsRead.then((standings) => ({ standings })),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  ])
  const pool = data?.pool ?? (await getPoolConfig())
  const mode = pool.competition_mode
  const tournament = capabilitiesFor(mode).showTournamentRounds
  const brands = data?.teamBrands ?? {}
  const name = (team: string) => brandFor(team, brands).shortName

  const slate = data?.slate ?? null
  const periods = data?.periods ?? []
  const period = data?.currentPeriod ?? null
  const dayNumber = period ? periods.findIndex((p) => p.id === period.id) + 1 : 0
  const lock = slate ? slateDeadline(slate, data?.slateGames ?? []) : null
  const lockIso = lock?.toISOString() ?? null
  const lockText = tipTime(lockIso)
  const now = data?.now ?? (await getEffectiveNow())
  const locked = lock ? lock <= now : false

  // The signed-in player's own entry.
  const me = session ? data?.players.find((player) => player.id === session.player_id) ?? null : null
  const todayPicks: MyPick[] = session && slate ? allMyPicks.filter((p) => p.slateId === slate.id) : []

  const alive = data?.aliveCount ?? 0
  const total = data?.totalPlayers ?? 0
  const submitted = data?.picksMade ?? 0
  const eliminatedBySlate = new Map<number, number>()
  for (const player of data?.players ?? []) {
    if (player.status === 'eliminated' && player.elimination_slate != null) {
      eliminatedBySlate.set(player.elimination_slate, (eliminatedBySlate.get(player.elimination_slate) ?? 0) + 1)
    }
  }
  const timeline = buildTimeline({ periods, currentId: slate?.id ?? null, totalEntries: total, aliveCount: alive, eliminatedBySlate, tournament })
  const timelineMax = Math.max(1, total)

  const entryState = !me
    ? null
    : me.status === 'eliminated'
      ? { text: 'Eliminated', tone: s.red }
      : todayPicks.length === 0
        ? { text: locked ? 'No pick at lock' : 'No pick submitted', tone: s.amber }
        : todayPicks.some((p) => p.autoAssigned)
          ? { text: 'Auto-assigned at lock', tone: s.amber }
          : locked
            ? { text: 'Pick locked', tone: s.gray }
            : { text: todayPicks.length === 1 ? 'Pick saved' : 'Picks saved', tone: s.gray }
  const myTeamText = todayPicks.map((p) => name(p.team)).join(', ')
  // The same names the header uses for the same actions.
  const pick = session
    ? pickStateOf({ hasSlate: !!slate, eliminated: me?.status === 'eliminated', locked, hasPick: todayPicks.length > 0 })
    : undefined
  const action = !pick || pick === 'none'
    ? null
    : pick === 'eliminated' || pick === 'locked'
      ? { href: '/sweat', label: 'View picks' }
      : { href: '/pick', label: pick === 'submitted' ? 'Change pick' : 'Make your pick' }
  const entryDeadline = lockIso && me && (pick === 'open' || pick === 'submitted')
    ? pick === 'submitted' ? `Change until ${lockText} CT` : `Picks lock at ${lockText} CT`
    : null

  const survivors = (data?.players ?? []).filter((player) => player.status === 'alive')
  const winner = pool.status === 'completed' && survivors.length === 1 ? survivors[0].full_name : null
  const standingsProps = {
    dayLabel: period ? `Day ${dayNumber}` : 'Today',
    hiddenUntil: slate && !locked ? lockText : null,
    showSeedTotal: capabilitiesFor(mode).showSeedTotal,
    signupsClosed: closed,
  }

  return (
    <PoolShell
      mode={mode}
      seasonYear={pool.season_year}
      account={session?.full_name ?? null}
      pick={pick}
      // The entry strip below carries the page's action (or log in).
      hideAction={!session || !!(me && action)}
      signupsClosed={closed}
    >
      <ContestRefresh />
      <ScrollToHash />
      <div className={s.kicker}>{period ? `${dayDate(period.date)} · ` : ''}{eventLabel(mode, pool.season_year)}</div>
      <h1 className={s.title}>{period ? pickDayTitle(period.round, period.date, dayNumber) : 'No games scheduled'}</h1>
      {!data && <p role="status" className={s.notice}>Pool data is unavailable. Refresh to try again.</p>}

      <section className={s.scoreboard} aria-label="Pool scoreboard">
        <div className={s.scoreCell}><span className={s.bigNum}>{alive}</span><span className={s.bigSub}> alive of {total}</span></div>
        <div className={s.scoreCell}><div className={s.cellLabel}>Eliminated</div><div className={s.cellValue}>{data?.eliminatedCount ?? 0}</div></div>
        <div className={s.scoreCell}>
          <div className={s.cellLabel}>Picks submitted</div>
          <div className={s.cellValue}>{submitted} <small>of {alive}</small></div>
          <div className={s.meter}><span style={{ width: `${alive ? (submitted / alive) * 100 : 0}%` }} /></div>
        </div>
        <div className={s.scoreCell}>
          <div className={s.cellLabel}>{entryDeadline ? 'Time to lock' : lockIso ? <>Locks<span className={s.liveExtra}> at first tip,</span> {lockText}</> : 'Lock time'}</div>
          <div className={s.cellValue}>{lockIso ? <LockCountdown deadline={lockIso} soonClassName={s.clockSoon} /> : 'TBD'}</div>
        </div>
      </section>

      {session && entryState && action ? (
        <section className={s.entryStrip} aria-label="Your pick">
          <span>
            {myTeamText ? (
              <>
                <small className={entryState.tone}>{entryState.text}</small>
                <span className={s.cardTeamRow}>
                  {todayPicks.length === 1 && <TeamLogo team={todayPicks[0].team} brands={brands} size={30} />}
                  <b className={s.cardTeam}>{myTeamText}</b>
                </span>
              </>
            ) : (
              <b className={`${s.cardTeam} ${entryState.tone}`}>{entryState.text}</b>
            )}
            {entryDeadline && <small className={s.gray}>{entryDeadline}</small>}
          </span>
          <Link className={s.cta} href={action.href}>{action.label}</Link>
        </section>
      ) : !session ? (
        <section className={s.entryStrip} aria-label="Your entry">
          <span><b className={s.cardTeam}>Your entry</b>{!closed && <small className={s.gray}>Entry is $25 via Venmo to @griffinsell.</small>}</span>
          {!closed && <Link className={`${s.cta} ${s.ctaQuiet}`} href="/signup">Join pool</Link>}
          <Link className={s.cta} href="/login">Log in</Link>
        </section>
      ) : null}

      {timeline.length > 1 && <SurvivalTimeline columns={timeline} max={timelineMax} />}

      <section id="standings" className={s.homeSection} aria-label="Standings">
        <div className={s.sectionHead}><h2>Standings</h2><span>{period ? `Through day ${dayNumber}` : ''}</span></div>
        {winner && <div className={s.winner}><span className={s.cellLabel}>Winner</span><b>{winner}</b></div>}
        {data && ready ? (
          <StandingsBlock standings={ready.standings} core={data} meId={session?.player_id} myTeams={todayPicks.map((p) => p.team)} {...standingsProps} />
        ) : data ? (
          // Everything above is built from today's data; the table needs the
          // whole season, so it streams in behind a same-size placeholder.
          <Suspense fallback={<StandingsTableSkeleton alive={alive} out={total - alive} showSeedTotal={standingsProps.showSeedTotal} />}>
            <TodayStandings core={data} meId={session?.player_id} myTeams={todayPicks.map((p) => p.team)} {...standingsProps} />
          </Suspense>
        ) : (
          <StandingsTable alive={[]} out={[]} teamBrands={{}} {...standingsProps} />
        )}
      </section>

      <RulesSection pool={pool} />
    </PoolShell>
  )
}

type StandingsTableProps = {
  core: ContestCore
  meId: string | undefined
  myTeams: string[]
  dayLabel: string
  hiddenUntil: string | null
  showSeedTotal: boolean
  signupsClosed: boolean
}

function StandingsBlock({ standings, core, meId, myTeams, ...table }: StandingsTableProps & { standings: StandingRow[] | null }) {
  if (!standings) return <p role="status" className={s.notice}>Standings are unavailable. Refresh to try again.</p>
  const rows = buildStandingsRows({ standings, periods: core.periods, meId, myTeams, brands: core.teamBrands })
  return <StandingsTable alive={rows.alive} out={rows.out} teamBrands={rows.teamBrands} {...table} />
}

async function TodayStandings(props: StandingsTableProps) {
  return <StandingsBlock standings={await getContestStandings(props.core)} {...props} />
}
