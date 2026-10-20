import ContestRefresh from '@/app/components/ContestRefresh'
import { pageMetadata } from '@/lib/site'
import { getPoolConfig } from '@/lib/pool'
import { capabilitiesFor } from '@/lib/competition'
import { getDashboardData } from '@/lib/dashboard'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { brandFor } from '@/lib/teamBrand'
import { eventLabel, tipTime, weekdayDay } from '@/lib/poolTheme'
import PoolShell from '../components/PoolShell'
import StandingsTable, { type AliveRow, type OutRow } from '../components/StandingsTable'
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
  const name = (team: string) => brandFor(team, brands).shortName
  const names = Object.fromEntries(Object.entries(brands).map(([abbr, brand]) => [abbr, brand.shortName]))
  const periods = data?.periods ?? []
  const period = data?.currentPeriod ?? null
  const dayNumber = period ? periods.findIndex((p) => p.id === period.id) + 1 : 0
  const dayLabel = dayNumber ? `Day ${dayNumber}` : 'Today'
  const periodByNumber = new Map(periods.map((p) => [p.number, p]))

  // Before lock everyone else's pick stays hidden; you always see your own.
  let myTeams: string[] = []
  if (session && data?.slate) {
    const { data: picks } = await (await getDb())
      .from('picks')
      .select('team')
      .eq('player_id', session.player_id)
      .eq('slate_id', data.slate.id)
    myTeams = (picks ?? []).map((pick: { team: string }) => pick.team)
  }

  const standings = data?.standings ?? []
  const alive: AliveRow[] = standings
    .filter((row) => row.status === 'alive')
    .map((row) => {
      const me = row.player_id === session?.player_id
      const revealedTeams = row.pick_revealed ? row.current_picks : []
      const teams = me ? myTeams : revealedTeams
      return {
        id: row.player_id,
        name: row.full_name,
        me,
        pick: teams.length ? teams.map(name).join(', ') : null,
        status: row.pick_revealed && teams.length ? 'picked' : me && teams.length ? 'submitted' : row.pick_locked ? 'locked' : 'none',
        seedTotal: row.seed_total,
      }
    })
  const out: OutRow[] = standings
    .filter((row) => row.status === 'eliminated')
    .map((row) => {
      const outPeriod = row.elimination_slate != null ? periodByNumber.get(row.elimination_slate) : undefined
      const losing = row.losing_picks?.length ? `Picked ${row.losing_picks.map(name).join(', ')}, lost` : row.elimination_reason
      return {
        id: row.player_id,
        name: row.full_name,
        out: outPeriod ? `Out ${weekdayDay(outPeriod.date)}` : 'Out',
        losing: losing ?? null,
        seedTotal: row.seed_total,
      }
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
          dayLabel={dayLabel}
          hiddenUntil={hiddenUntil}
          showSeedTotal={capabilitiesFor(mode).showSeedTotal}
          signupsClosed={signupsClosed}
        />
      )}
    </PoolShell>
  )
}
