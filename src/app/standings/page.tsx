import ContestRefresh from '@/app/components/ContestRefresh'
import { pageMetadata } from '@/lib/site'
import { getPoolConfig } from '@/lib/pool'
import { capabilitiesFor } from '@/lib/competition'
import { getDashboardData } from '@/lib/dashboard'
import { getSession } from '@/lib/session'
import { eventLabel, tipTime } from '@/lib/poolTheme'
import PoolShell from '../components/PoolShell'
import StandingsTable from '../components/StandingsTable'
import { buildStandingsRows, loadMyTodayTeams } from '@/lib/standingsRows'
import s from '../components/pp.module.css'

// Your own row is marked, so the page renders per request.
export const dynamic = 'force-dynamic'

export const metadata = pageMetadata('Standings', 'Who is still alive in the Pick and Pray survivor pool, and who is out.', '/standings', true)

export default async function StandingsPage() {
  const { haveSignupsClosed } = await import('@/lib/season')
  const [data, signupsClosed, session] = await Promise.all([getDashboardData(), haveSignupsClosed(), getSession()])
  const pool = data?.pool ?? (await getPoolConfig())
  const mode = pool.competition_mode
  const brands = data?.teamBrands ?? {}
  const names = Object.fromEntries(Object.entries(brands).map(([abbr, brand]) => [abbr, brand.shortName]))
  const periods = data?.periods ?? []
  const period = data?.currentPeriod ?? null
  const dayNumber = period ? periods.findIndex((p) => p.id === period.id) + 1 : 0
  const dayLabel = dayNumber ? `Day ${dayNumber}` : 'Today'

  const myTeams = await loadMyTodayTeams(session?.player_id, data?.slate?.id)
  const { alive, out, teamBrands } = buildStandingsRows({
    standings: data?.standings ?? [],
    periods,
    meId: session?.player_id,
    myTeams,
    brands,
  })

  const hiddenUntil = data?.slate && !data.picksRevealed ? tipTime(data.firstTip ?? data.slate.locks_at) : null
  const winner = data && pool.status === 'completed' && alive.length === 1 ? alive[0] : null

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session?.full_name} signupsClosed={signupsClosed} names={names} width="narrow">
      <ContestRefresh />
      <div className={s.kicker}>{eventLabel(mode, pool.season_year)}{dayNumber ? ` · through ${dayLabel}` : ''}</div>
      <h1 className={s.title}>Standings</h1>
      {winner && <div className={s.winner}><span className={s.cellLabel}>Winner</span><b>{winner.name}</b></div>}
      {!data ? (
        <p className={s.notice}>Standings appear here when the first pick day is ready.</p>
      ) : (
        <StandingsTable
          alive={alive}
          out={out}
          teamBrands={teamBrands}
          dayLabel={dayLabel}
          hiddenUntil={hiddenUntil}
          showSeedTotal={capabilitiesFor(mode).showSeedTotal}
          signupsClosed={signupsClosed}
        />
      )}
    </PoolShell>
  )
}
