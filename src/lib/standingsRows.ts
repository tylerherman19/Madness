import 'server-only'
import type { StandingRow } from '@/types'
import type { PickPeriod } from './competition'
import { brandFor, type TeamBrand, type TeamBrandDirectory } from './teamBrand'
import { weekdayDay } from './poolTheme'
import { getDb } from './testMode'

export interface AliveRow {
  id: string
  name: string
  me: boolean
  // Teams shown for today: revealed picks, or always your own.
  teams: string[]
  status: 'locked' | 'none' | 'submitted' | 'picked'
  seedTotal: number
}

export interface OutRow {
  id: string
  name: string
  out: string
  teams: string[] // the losing pick(s)
  losing: string | null
  seedTotal: number
}

// The signed-in player's own pick for the active slate. Theirs to see before lock.
export async function loadMyTodayTeams(playerId: string | undefined, slateId: string | undefined): Promise<string[]> {
  if (!playerId || !slateId) return []
  const { data } = await (await getDb()).from('picks').select('team').eq('player_id', playerId).eq('slate_id', slateId)
  return (data ?? []).map((pick: { team: string }) => pick.team)
}

// Standings rows for the Today and Standings pages. Other entries' picks for
// the open day stay hidden until lock; the server never sends them early.
export function buildStandingsRows({
  standings,
  periods,
  meId,
  myTeams,
  brands,
}: {
  standings: StandingRow[]
  periods: PickPeriod[]
  meId: string | undefined
  myTeams: string[]
  brands: TeamBrandDirectory
}): { alive: AliveRow[]; out: OutRow[]; teamBrands: Record<string, TeamBrand> } {
  const name = (team: string) => brandFor(team, brands).shortName
  const periodByNumber = new Map(periods.map((p) => [p.number, p]))
  const alive: AliveRow[] = standings
    .filter((row) => row.status === 'alive')
    .map((row) => {
      const me = row.player_id === meId
      const teams = me ? myTeams : row.pick_revealed ? row.current_picks : []
      return {
        id: row.player_id,
        name: row.full_name,
        me,
        teams,
        status: row.pick_revealed && teams.length ? 'picked' : me && teams.length ? 'submitted' : row.pick_locked ? 'locked' : 'none',
        seedTotal: row.seed_total,
      }
    })
  const out: OutRow[] = standings
    .filter((row) => row.status === 'eliminated')
    .map((row) => {
      const outPeriod = row.elimination_slate != null ? periodByNumber.get(row.elimination_slate) : undefined
      const teams = row.losing_picks ?? []
      return {
        id: row.player_id,
        name: row.full_name,
        out: outPeriod ? `Out ${weekdayDay(outPeriod.date)}` : 'Out',
        teams,
        losing: teams.length ? `Picked ${teams.map(name).join(', ')}, lost` : row.elimination_reason,
        seedTotal: row.seed_total,
      }
    })
  // Only the brands the lists show, so the client gets a small payload.
  const used = new Set([...alive.flatMap((r) => r.teams), ...out.flatMap((r) => r.teams)])
  const teamBrands = Object.fromEntries([...used].map((team) => [team, brandFor(team, brands)]))
  return { alive, out, teamBrands }
}
