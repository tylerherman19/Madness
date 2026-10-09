// Count completed qualifying periods, never selections or pending games.
export function survivedPeriodsByPlayer(
  picks: { player_id: string; slate_id: string; team: string; loss_excused?: boolean }[],
  games: { slate_id: string; home_team: string; away_team: string; result: string }[],
  periods: Record<string, { key: string; quota: number }>
): Record<string, number> {
  const groups = new Map<string, { player: string; quota: number; won: boolean[] }>()
  const outcomes = new Map<string, boolean>()
  for (const game of games) {
    outcomes.set(`${game.slate_id}:${game.home_team}`, game.result === 'home_win')
    outcomes.set(`${game.slate_id}:${game.away_team}`, game.result === 'away_win')
  }
  for (const pick of picks) {
    const period = periods[pick.slate_id] ?? { key: pick.slate_id, quota: 1 }
    const key = `${pick.player_id}:${period.key}`
    const group = groups.get(key) ?? { player: pick.player_id, quota: period.quota, won: [] }
    group.won.push(pick.loss_excused === true || outcomes.get(`${pick.slate_id}:${pick.team}`) === true)
    groups.set(key, group)
  }
  const totals: Record<string, number> = {}
  for (const group of groups.values()) {
    if (group.won.length === group.quota && group.won.every(Boolean)) totals[group.player] = (totals[group.player] ?? 0) + 1
  }
  return totals
}
