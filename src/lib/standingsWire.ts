// The standings as they travel to the browser. One compact row per entry,
// holding only what the table renders; every default is left out, so an entry
// with nothing to show beyond its name is just that name, as a bare string. The table expands them again before it
// searches, sorts or renders, so those all still run over every entry.
//
// Names are unique across the pool (publicPlayerLabels adds an id suffix when
// two collide), so the name doubles as the row key and no id is sent.
import type { AliveRow, OutRow } from './standingsRows.ts'

export type PackedAlive = {
  n: string // name
  me?: 1
  t?: string[] // teams shown: a revealed pick, or your own
  s?: 'l' | 'p' | 's' // locked, picked, submitted; absent means no pick yet
  v?: number // seed total, only when the pool shows it
}

export type PackedOut = {
  n: string
  me?: 1
  o?: number // slate number they went out on; its label is in `outLabels`
  t?: string[] // the losing pick(s)
  r?: string // why, when there is no losing pick to show
  v?: number
}

export interface PackedStandings {
  alive: (PackedAlive | string)[]
  out: (PackedOut | string)[]
  outLabels: Record<number, string>
}

const STATUS = { l: 'locked', p: 'picked', s: 'submitted' } as const

export function unpackAlive(rows: readonly (PackedAlive | string)[]): AliveRow[] {
  return rows.map((packed) => {
    const row: PackedAlive = typeof packed === 'string' ? { n: packed } : packed
    return {
    id: row.n,
    name: row.n,
    me: row.me === 1,
    teams: row.t ?? [],
    status: row.s ? STATUS[row.s] : 'none',
    seedTotal: row.v ?? 0,
    }
  })
}

export function unpackOut(rows: readonly (PackedOut | string)[], outLabels: Record<number, string>, teamName: (team: string) => string): OutRow[] {
  return rows.map((packed) => {
    const row: PackedOut = typeof packed === 'string' ? { n: packed } : packed
    const teams = row.t ?? []
    return {
      id: row.n,
      name: row.n,
      me: row.me === 1,
      out: row.o != null && outLabels[row.o] ? outLabels[row.o] : 'Out',
      teams,
      losing: teams.length ? `Picked ${teams.map(teamName).join(', ')}, lost` : row.r ?? null,
      seedTotal: row.v ?? 0,
    }
  })
}
