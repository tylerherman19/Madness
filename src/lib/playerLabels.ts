export function publicPlayerLabels(players: { id: string; full_name: string }[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const player of players) counts.set(player.full_name, (counts.get(player.full_name) ?? 0) + 1)
  return new Map(players.map(player => {
    let size = 6
    while (size < player.id.length && players.some(other => other.id !== player.id && other.full_name === player.full_name && other.id.slice(0, size) === player.id.slice(0, size))) size++
    return [player.id, counts.get(player.full_name)! > 1 ? `${player.full_name} · ${player.id.slice(0, size)}` : player.full_name]
  }))
}
