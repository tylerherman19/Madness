import type { StandingRow } from '@/types'

export function seedTotalsByPlayer(
  picks: { player_id: string; seed?: number | null }[]
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const pick of picks) {
    totals[pick.player_id] = (totals[pick.player_id] ?? 0) + (pick.seed ?? 0)
  }
  return totals
}

export function compareBySeedTotal(a: StandingRow, b: StandingRow): number {
  return b.seed_total - a.seed_total || b.slates_survived - a.slates_survived ||
    a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
}
