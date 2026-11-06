import { pageMetadata } from '@/lib/site'
import SweatBoard from './SweatBoard'
import PoolShell from '@/app/components/PoolShell'
import { getContestCore } from '@/lib/dashboard'
import { getPoolConfig } from '@/lib/pool'
import { getSession } from '@/lib/session'
import { getDb, isTestMode } from '@/lib/testMode'
import { brandsFor } from '@/lib/teamBrand'
import { dayDate, pickDayTitle } from '@/lib/poolTheme'

// The board polls /api/sweat on its own; the shell is per request because it
// shows the signed-in player's own pick.
export const dynamic = 'force-dynamic'

export const metadata = pageMetadata('Sweat Board', 'Follow every pick in the Pick and Pray survivor pool as the games are played.', '/sweat', true)

export default async function SweatPage() {
  const [data, session, sandbox] = await Promise.all([getContestCore(), getSession(), isTestMode()])
  const pool = data?.pool ?? (await getPoolConfig())
  const mode = pool.competition_mode
  const period = data?.currentPeriod ?? null
  const dayNumber = period ? (data?.periods ?? []).findIndex((p) => p.id === period.id) + 1 : 0

  // The signed-in player's own pick for the day is theirs to see before lock.
  let myTeams: string[] | null = null
  if (session) {
    myTeams = []
    if (data?.slate) {
      const { data: picks } = await (await getDb())
        .from('picks')
        .select('team')
        .eq('player_id', session.player_id)
        .eq('slate_id', data.slate.id)
      myTeams = (picks ?? []).map((pick: { team: string }) => pick.team)
    }
  }

  // Only today's teams: the board's own feed carries the brands for every
  // game it shows, so nothing is lost if the slate changes while it is open.
  const games = data?.slateGames ?? []
  const brands = brandsFor([...games.flatMap((g) => [g.home_team, g.away_team]), ...(myTeams ?? [])], data?.teamBrands ?? {})

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session?.full_name ?? null}>
      <SweatBoard
        teamBrands={brands}
        myTeams={myTeams}
        sandbox={sandbox}
        kicker={period ? `${dayDate(period.date)} · ${pickDayTitle(period.round, period.date, dayNumber)}` : ''}
      />
    </PoolShell>
  )
}
