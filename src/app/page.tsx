import Link from 'next/link'
import { pageMetadata } from '@/lib/site'
import { getDashboardData } from '@/lib/dashboard'
import { haveSignupsClosed } from '@/lib/season'
import { getSession } from '@/lib/session'
import { getPoolConfig } from '@/lib/pool'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline } from '@/lib/deadline'
import { loadMyPicks, type MyPick } from '@/lib/myEntry'
import { buildTimeline } from '@/lib/timeline'
import { conferenceGroup, getTeamConferences } from '@/lib/teams'
import { brandFor } from '@/lib/teamBrand'
import { capabilitiesFor } from '@/lib/competition'
import { dayDate, eventLabel, pickDayTitle, teamTag, tipTime, weekdayMonthDay } from '@/lib/poolTheme'
import PoolShell from './components/PoolShell'
import LockCountdown from './components/LockCountdown'
import s from './components/pp.module.css'

// Signed-in players see their own entry here, so the page renders per request.
export const dynamic = 'force-dynamic'

export const metadata = pageMetadata('Today', 'Today in the Pick and Pray college basketball survivor pool.', '/', true)

export default async function Today() {
  const [data, closed, session] = await Promise.all([getDashboardData(), haveSignupsClosed(), getSession()])
  const pool = data?.pool ?? (await getPoolConfig())
  const mode = pool.competition_mode
  const tournament = capabilitiesFor(mode).showTournamentRounds
  const brands = data?.teamBrands ?? {}
  const name = (team: string) => brandFor(team, brands).shortName
  const names = Object.fromEntries(Object.entries(brands).map(([abbr, brand]) => [abbr, brand.shortName]))

  const slate = data?.slate ?? null
  const periods = data?.periods ?? []
  const period = data?.currentPeriod ?? null
  const dayNumber = period ? periods.findIndex((p) => p.id === period.id) + 1 : 0
  const games = (data?.slateGames ?? []).slice().sort((a, b) => Number(a.time_tbd) - Number(b.time_tbd) || new Date(a.tip_time).getTime() - new Date(b.tip_time).getTime())
  const lock = slate ? slateDeadline(slate, games) : null
  const lockIso = lock?.toISOString() ?? null
  const lockText = tipTime(lockIso)
  const now = await getEffectiveNow()
  const locked = lock ? lock <= now : false

  const conferences = !tournament && games.length ? await getTeamConferences(await getDb()).catch(() => ({})) : {}

  // The signed-in player's own entry.
  const me = session ? data?.standings.find((row) => row.player_id === session.player_id) ?? null : null
  const myPicks: MyPick[] = session && data ? await loadMyPicks(session.player_id, periods.map((p) => p.id)) : []
  const todayPicks = myPicks.filter((p) => p.slateId === slate?.id)
  const used = new Set(myPicks.filter((p) => p.slateId !== slate?.id).map((p) => p.team))
  const mine = new Set(todayPicks.map((p) => p.team))
  const periodById = new Map(periods.map((p) => [p.id, p]))
  const run = myPicks
    .filter((p) => p.slateId !== slate?.id)
    .map((p) => ({ ...p, period: periodById.get(p.slateId) }))
    .sort((a, b) => (a.period?.date ?? '').localeCompare(b.period?.date ?? ''))

  const alive = data?.aliveCount ?? 0
  const total = data?.totalPlayers ?? 0
  const submitted = data?.picksMade ?? 0
  const eliminatedBySlate = new Map<number, number>()
  for (const row of data?.standings ?? []) {
    if (row.status === 'eliminated' && row.elimination_slate != null) {
      eliminatedBySlate.set(row.elimination_slate, (eliminatedBySlate.get(row.elimination_slate) ?? 0) + 1)
    }
  }
  const timeline = buildTimeline({ periods, currentId: slate?.id ?? null, totalEntries: total, aliveCount: alive, eliminatedBySlate, tournament })
  const timelineMax = Math.max(1, total)

  const pickLabel = period ? `Day ${dayNumber} pick` : 'Next pick'
  const entryState = !me
    ? null
    : me.status === 'eliminated'
      ? { text: 'Out', tone: s.red }
      : todayPicks.length === 0
        ? { text: locked ? 'No pick at lock' : 'Not submitted', tone: s.amber }
        : todayPicks.some((p) => p.autoAssigned)
          ? { text: 'Auto-assigned at lock', tone: s.amber }
          : locked
            ? { text: `Locked at ${lockText}`, tone: s.gray }
            : { text: `Submitted · change until ${lockText}`, tone: s.green }
  const myTeamText = todayPicks.length ? todayPicks.map((p) => name(p.team)).join(', ') : me?.status === 'eliminated' ? 'Eliminated' : 'No pick yet'
  const action = !session
    ? null
    : me?.status === 'eliminated'
      ? { href: '/standings', label: 'View standings' }
      : locked || !slate
        ? { href: '/sweat', label: 'Open sweat board' }
        : { href: '/pick', label: todayPicks.length ? 'Change your pick' : 'Make your pick' }

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session?.full_name} signupsClosed={closed} names={names}>
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
          <div className={s.cellLabel}>{lockIso ? <>Locks<span className={s.liveExtra}> at first tip</span> · {lockText}</> : 'Lock time'}</div>
          <div className={s.cellValue}>{lockIso ? <LockCountdown deadline={lockIso} soonClassName={s.clockSoon} /> : 'TBD'}</div>
        </div>
      </section>

      {session && me && action && (
        <section className={s.mobileEntry} aria-label="Your pick">
          <span>
            <small className={entryState?.tone}>{pickLabel} · {entryState?.text}</small>
            <b>{myTeamText}</b>
          </span>
          <Link href={action.href}>{action.label}</Link>
        </section>
      )}
      {!session && (
        <section className={s.mobileEntry} aria-label="Your entry">
          <span><b>Your entry</b></span>
          <Link href="/login">Log in</Link>
        </section>
      )}

      {timeline.length > 1 && (
        <section className={s.timeline} aria-label="Survival timeline">
          <div className={s.timelineHead}><h2>Survival timeline</h2><span>Entries remaining after each day</span></div>
          <div className={s.tlBars} style={{ gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))` }}>
            {timeline.map((col) => (
              <div className={s.tlCol} data-state={col.state} key={col.key}>
                <span className={s.tlNum}>{col.remaining ?? ''}{col.state === 'today' && <small> Pending</small>}</span>
                <span className={s.tlBar} style={{ '--r': col.remaining == null ? 0 : col.remaining / timelineMax } as React.CSSProperties} />
              </div>
            ))}
          </div>
          <div className={s.tlLabels} style={{ gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))` }}>
            {timeline.map((col) => (
              <div className={s.tlLabel} data-state={col.state} key={col.key}>{col.label}<small>{col.date}</small></div>
            ))}
          </div>
        </section>
      )}

      <div className={s.split}>
        <section aria-label="Today's schedule">
          <div className={s.sectionHead}><h2>{data?.slateIsToday || !period ? 'Today’s games' : `${weekdayMonthDay(period.date)} games`}</h2><span>{games.length} games</span></div>
          {games.map((game) => (
            <div className={s.gameRow} key={game.id}>
              <span className={s.gameTime}><b>{game.time_tbd ? 'TBD' : tipTime(game.tip_time)}</b><span>{game.tv ?? ''}</span></span>
              <span className={s.sides}>
                {([[game.away_team, game.away_seed], [game.home_team, game.home_seed]] as const).map(([team, seed]) => {
                  const note = mine.has(team) ? 'mine' : used.has(team) ? 'used' : undefined
                  const tag = teamTag(mode, seed, game.round_label)
                  return (
                    <span className={s.side} data-note={note} key={team}>
                      <span><span className={s.tag}>{tag ?? ''}</span>{name(team)}</span>
                      {note && <span className={s.sideNote}>{note === 'mine' ? 'Your pick' : 'Used'}</span>}
                    </span>
                  )
                })}
              </span>
              <span className={s.group}>{tournament ? game.region ?? '' : conferenceGroup(game.away_team, game.home_team, conferences) ?? ''}</span>
            </div>
          ))}
          {games.length === 0 && <p className={s.empty}>The next slate appears here when it is set.</p>}
        </section>

        <aside className={s.aside} aria-label="Your entry">
          <div className={s.asideHead}>
            <h2>Your entry</h2>
            {me && <span className={me.status === 'alive' ? s.green : s.red}>{me.status === 'alive' ? 'Alive' : 'Out'}</span>}
          </div>
          {session ? (
            <div className={s.entryBlock}>
              <div className={s.card}>
                <div className={s.cardLabel}>{pickLabel}</div>
                <div className={s.cardTeam}>{myTeamText}</div>
                {entryState && <div className={`${s.cardState} ${entryState.tone}`}>{entryState.text}</div>}
              </div>
              {action && <Link className={s.cta} href={action.href}>{action.label}</Link>}
            </div>
          ) : (
            <div className={s.entryBlock}>
              <div className={s.ctaRow}>
                <Link className={s.cta} href="/login">Log in</Link>
                {!closed && <Link className={`${s.cta} ${s.ctaQuiet}`} href="/signup">Join pool</Link>}
              </div>
              {!closed && <p className={`${s.small}`} style={{ marginTop: 10 }}>Entry is $25 via Venmo to @griffinsell.</p>}
            </div>
          )}

          {run.length > 0 && (
            <div className={s.sub}>
              <h3>Your run</h3>
              {run.map((pick) => (
                <div className={s.runRow} key={`${pick.slateId}-${pick.team}`}>
                  <span>{pick.period ? weekdayMonthDay(pick.period.date) : ''}</span>
                  <b>{name(pick.team)}</b>
                  <span className={pick.result === 'won' ? s.green : pick.result === 'lost' ? s.red : s.gray}>
                    {pick.result === 'won' ? 'Won' : pick.result === 'lost' ? 'Lost' : 'Pending'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {slate && (
            <div className={s.sub}>
              <h3>Pool picks</h3>
              <p>{submitted} of {alive} submitted · revealed at {lockText}</p>
              <div className={s.poolBar}><span style={{ width: `${alive ? (submitted / alive) * 100 : 0}%` }} /></div>
            </div>
          )}
        </aside>
      </div>
    </PoolShell>
  )
}
