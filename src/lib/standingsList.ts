// Pure list logic for the standings table: order, search and the "show more"
// window. Kept free of React and server-only imports so it can be unit tested.
// Search and order always run over the full list; only the rendered slice is
// windowed, so a name that is not on screen is still found.
import type { AliveRow, OutRow } from './standingsRows.ts'

export type SortMode = 'alphabetical' | 'team' | 'seeds'

// How many entries each list renders at first, and how many "Show more" adds.
export const INITIAL_ROWS = 100
export const ROWS_STEP = 100

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
export const compareNames = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name)

// Your own entry first, then A to Z; or highest seed total first.
export function sortAlive(rows: readonly AliveRow[], mode: SortMode): AliveRow[] {
  const copy = rows.slice()
  if (mode === 'seeds') return copy.sort((a, b) => b.seedTotal - a.seedTotal || compareNames(a, b))
  return copy.sort((a, b) => Number(b.me) - Number(a.me) || compareNames(a, b))
}

export function sortOut(rows: readonly OutRow[], mode: SortMode): OutRow[] {
  const copy = rows.slice()
  return copy.sort(mode === 'seeds' ? (a, b) => b.seedTotal - a.seedTotal || compareNames(a, b) : compareNames)
}

// Case-insensitive substring match on the entry name; keeps the incoming order.
export function filterByName<T extends { name: string }>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows.slice()
  return rows.filter((row) => row.name.toLowerCase().includes(needle))
}

// A flat list of group headings and entries, so grouped and plain views window
// the same way and every item has one position in the full list.
export type ListItem<G, R> = { type: 'head'; group: G } | { type: 'row'; row: R }

export function plainItems<R>(rows: readonly R[]): ListItem<never, R>[] {
  return rows.map((row) => ({ type: 'row', row }))
}

export function groupedItems<G extends { rows: readonly R[] }, R>(groups: readonly G[]): ListItem<G, R>[] {
  return groups.flatMap((group) => [
    { type: 'head', group } as ListItem<G, R>,
    ...group.rows.map((row): ListItem<G, R> => ({ type: 'row', row })),
  ])
}

// The first `rowLimit` entries, plus the headings that lead them. `shown` is a
// prefix of `items`, so the item at index i has the same position (i + 1) in the
// full list and in the window; that position is its aria-rowindex.
export function windowItems<G, R>(
  items: readonly ListItem<G, R>[],
  rowLimit: number
): { shown: ListItem<G, R>[]; rowsShown: number; rowsTotal: number } {
  let rowsShown = 0
  let rowsTotal = 0
  let cut = 0
  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== 'row') continue
    rowsTotal++
    if (rowsShown < rowLimit) {
      rowsShown++
      cut = i + 1
    }
  }
  return { shown: items.slice(0, cut), rowsShown, rowsTotal }
}
