// Teams an organizer can enter for an entry on the active day: only teams playing that day,
// grouped by game, minus teams the entry has already used (its current pick stays selectable).

export interface DayGame { home_team: string; away_team: string }
export interface PickChoice { team: string; label: string }

export function pickChoices(games: DayGame[], used: string[], current?: string | null): PickChoice[] {
  const blocked = new Set(used)
  const out: PickChoice[] = []
  for (const game of games) {
    for (const [team, other] of [[game.home_team, game.away_team], [game.away_team, game.home_team]] as const) {
      if (blocked.has(team) && team !== current) continue
      if (out.some((choice) => choice.team === team)) continue
      out.push({ team, label: `${team} (vs ${other})` })
    }
  }
  return out.sort((a, b) => a.team.localeCompare(b.team))
}
