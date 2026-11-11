import 'server-only'
import type { StandingRow } from '@/types'
import type { PickPeriod } from './competition'
import { brandFor, type TeamBrand, type TeamBrandDirectory } from './teamBrand'
import { weekdayDay } from './poolTheme'
import type { PackedAlive, PackedOut, PackedStandings } from './standingsWire'
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
  me: boolean
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

// Standings rows for the Today and Standings pages, packed for the browser
// (lib/standingsWire.ts). Other entries' picks for the open day stay hidden
// until lock; the server never sends them early.
export function buildStandingsRows({
  standings,
  periods,
  meId,
  myTeams,
  brands,
  showSeedTotal,
}: {
  standings: StandingRow[]
  periods: PickPeriod[]
  meId: string | undefined
  myTeams: string[]
  brands: TeamBrandDirectory
  showSeedTotal: boolean
}): PackedStandings & { teamBrands: Record<string, TeamBrand> } {
  const periodByNumber = new Map(periods.map((p) => [p.number, p]))
  const outLabels: Record<number, string> = {}
  const used = new Set<string>()
  const alive: (PackedAlive | string)[] = []
  const out: (PackedOut | string)[] = []
  for (const row of standings) {
    const me = row.player_id === meId
    const seed = showSeedTotal && row.seed_total ? { v: row.seed_total } : {}
    if (row.status === 'alive') {
      const teams = me ? myTeams : row.pick_revealed ? row.current_picks : []
      const state = row.pick_revealed && teams.length ? 'p' : me && teams.length ? 's' : row.pick_locked ? 'l' : undefined
      for (const team of teams) used.add(team)
      const packed: PackedAlive = { n: row.full_name, ...(me && { me: 1 as const }), ...(teams.length && { t: teams }), ...(state && { s: state }), ...seed }
      alive.push(Object.keys(packed).length === 1 ? row.full_name : packed)
    } else if (row.status === 'eliminated') {
      const teams = row.losing_picks ?? []
      const period = row.elimination_slate != null ? periodByNumber.get(row.elimination_slate) : undefined
      if (period) outLabels[period.number] = `Out ${weekdayDay(period.date)}`
      for (const team of teams) used.add(team)
      const packed: PackedOut = {
        n: row.full_name,
        ...(me && { me: 1 as const }),
        ...(period && { o: period.number }),
        ...(teams.length && { t: teams }),
        ...(!teams.length && row.elimination_reason && { r: row.elimination_reason }),
        ...seed,
      }
      out.push(Object.keys(packed).length === 1 ? row.full_name : packed)
    }
  }
  // Only the brands the lists show, so the client gets a small payload.
  const teamBrands = Object.fromEntries([...used].map((team) => [team, brandFor(team, brands)]))
  return { alive, out, outLabels, teamBrands }
}
