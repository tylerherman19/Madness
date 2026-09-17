// Pool-internal analytics. Current-slate picks are included only after the
// slate reveal rule makes them public.

export interface InsightPlayer {
  id: string
  full_name: string
  status: string
  elimination_slate: number | null
}

export interface InsightWeek {
  id: string
  slate_number: number
}

export interface InsightPick {
  player_id: string
  slate_id: string
  team: string
}

export interface InsightsInput {
  players: InsightPlayer[]
  picks: InsightPick[]
  currentSlate: InsightWeek | null
  revealedCurrentPicks: Record<string, string>
  potSize: number
  teamUniverse: string[]
}

export interface ExposureRow {
  team: string
  count: number
  survivorsIfLoses: number
}

export interface ExposureModule {
  rows: ExposureRow[]
  aliveCount: number
  revealedCount: number
  hiddenCount: number
  complete: boolean
  distinctTeams: number
  worstCase: ExposureRow | null
  floor: number
}

export interface LeverageRow {
  player_id: string
  full_name: string
  team: string
  sharedWith: number
  bestCaseField: number
  impliedPayout: number
}

export interface LeverageModule {
  rows: LeverageRow[]
  loneWolves: LeverageRow[]
  headline: string
  deck: string
}

export interface ScarcityRow {
  team: string
  burnedBy: number
  availableTo: number
}

export interface ScarcityModule {
  rows: ScarcityRow[]
  aliveCount: number
  uniqueHolds: { team: string; holder: string }[]
  exhausted: string[]
}

export interface PoolInsights {
  exposure: ExposureModule | null
  leverage: LeverageModule | null
  scarcity: ScarcityModule | null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function computeInsights(input: InsightsInput): PoolInsights {
  const { players, picks, currentSlate, revealedCurrentPicks, potSize, teamUniverse } = input
  const alive = players.filter((player) => player.status === 'alive')
  const nameById = Object.fromEntries(players.map((player) => [player.id, player.full_name]))
  const pastPicks = picks.filter((pick) => !currentSlate || pick.slate_id !== currentSlate.id)

  const usedByPlayer: Record<string, Set<string>> = {}
  for (const player of alive) usedByPlayer[player.id] = new Set()
  for (const pick of pastPicks) usedByPlayer[pick.player_id]?.add(pick.team)
  for (const [playerId, team] of Object.entries(revealedCurrentPicks)) usedByPlayer[playerId]?.add(team)

  return {
    exposure: buildExposure({ alive, revealedCurrentPicks, currentSlate }),
    leverage: buildLeverage({ alive, revealedCurrentPicks, potSize, nameById }),
    scarcity: buildScarcity({ alive, usedByPlayer, nameById, pastPicks, teamUniverse }),
  }
}

function buildExposure({ alive, revealedCurrentPicks, currentSlate }: {
  alive: InsightPlayer[]
  revealedCurrentPicks: Record<string, string>
  currentSlate: InsightWeek | null
}): ExposureModule | null {
  if (!currentSlate || alive.length === 0) return null

  const counts: Record<string, number> = {}
  let revealedCount = 0
  for (const player of alive) {
    const team = revealedCurrentPicks[player.id]
    if (!team) continue
    counts[team] = (counts[team] || 0) + 1
    revealedCount++
  }
  if (revealedCount === 0) return null

  const rows = Object.entries(counts)
    .map(([team, count]) => ({ team, count, survivorsIfLoses: alive.length - count }))
    .sort((a, b) => b.count - a.count || a.team.localeCompare(b.team))
  const worstCase = rows[0] ?? null

  return {
    rows,
    aliveCount: alive.length,
    revealedCount,
    hiddenCount: alive.length - revealedCount,
    complete: revealedCount === alive.length,
    distinctTeams: rows.length,
    worstCase,
    floor: alive.length - (worstCase?.count ?? 0),
  }
}

function buildLeverage({ alive, revealedCurrentPicks, potSize, nameById }: {
  alive: InsightPlayer[]
  revealedCurrentPicks: Record<string, string>
  potSize: number
  nameById: Record<string, string>
}): LeverageModule | null {
  if (alive.filter((player) => revealedCurrentPicks[player.id]).length !== alive.length) return null

  const counts: Record<string, number> = {}
  for (const player of alive) {
    const team = revealedCurrentPicks[player.id]
    if (team) counts[team] = (counts[team] || 0) + 1
  }
  if (Object.keys(counts).length < 2 || alive.length < 3) return null

  const rows = alive
    .map((player) => {
      const team = revealedCurrentPicks[player.id]
      const count = counts[team]
      return {
        player_id: player.id,
        full_name: nameById[player.id] ?? player.full_name,
        team,
        sharedWith: count - 1,
        bestCaseField: count,
        impliedPayout: count > 0 ? Math.floor(potSize / count) : 0,
      }
    })
    .sort((a, b) => a.bestCaseField - b.bestCaseField || a.full_name.localeCompare(b.full_name))

  const loneWolves = rows.filter((row) => row.bestCaseField === 1)
  const chalk = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  let headline: string
  if (loneWolves.length === 1) {
    const player = loneWolves[0]
    headline = `${player.full_name} is alone on ${player.team}. If it wins and ${chalk[0]} doesn't, the pot goes from a ${chalk[1]}-way split to $${player.impliedPayout}.`
  } else if (loneWolves.length > 1) {
    headline = `${loneWolves.length} survivors are the only ones on their team. A bad day for ${chalk[0]} hands each of them the pool.`
  } else {
    const best = rows[0]
    headline = `Nobody is out on their own. The smallest bloc is ${best.bestCaseField} ${plural(best.bestCaseField, 'player', 'players')} on ${best.team}.`
  }

  return {
    rows,
    loneWolves,
    headline,
    deck: 'Best case assumes your team wins and every other public pick loses. It is a ceiling, not a prediction.',
  }
}

function buildScarcity({ alive, usedByPlayer, nameById, pastPicks, teamUniverse }: {
  alive: InsightPlayer[]
  usedByPlayer: Record<string, Set<string>>
  nameById: Record<string, string>
  pastPicks: InsightPick[]
  teamUniverse: string[]
}): ScarcityModule | null {
  if (alive.length === 0 || pastPicks.length === 0) return null

  const rows = teamUniverse.map((team) => {
    const burnedBy = alive.filter((player) => usedByPlayer[player.id]?.has(team)).length
    return { team, burnedBy, availableTo: alive.length - burnedBy }
  })
  const uniqueHolds: { team: string; holder: string }[] = []
  for (const row of rows) {
    if (row.availableTo !== 1 || row.burnedBy === 0) continue
    const holder = alive.find((player) => !usedByPlayer[player.id]?.has(row.team))
    if (holder) uniqueHolds.push({ team: row.team, holder: nameById[holder.id] ?? holder.full_name })
  }

  return {
    rows,
    aliveCount: alive.length,
    uniqueHolds,
    exhausted: rows.filter((row) => row.availableTo === 0).map((row) => row.team),
  }
}
