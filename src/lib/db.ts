import type { PostgrestError } from '@supabase/supabase-js'

// PostgREST caps every response at the project's "Max Rows" setting (1,000 on
// Supabase by default) and says nothing when it does — the query simply comes
// back short. A full season is ~2,000 games and a few thousand picks, so any
// query that isn't scoped to one slate or one player must page.
//
// Every paged query needs a stable `.order(...)` (use a unique column such as
// `id`), otherwise rows can shift between pages.

const PAGE_SIZE = 1000

// Slate ids go into the URL of `.in('slate_id', …)` filters. A season is a
// couple hundred slates, which would make a URL long enough for proxies to
// reject, so id lists are split into batches of this size.
const IN_BATCH_SIZE = 100

type PageResult = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>

// Fetch every row by walking `.range()` pages until one comes back empty.
// Stopping on an empty page rather than a short one keeps this correct even
// if the project's Max Rows is set below PAGE_SIZE. Errors throw: a partial
// result that looks complete is exactly the failure this exists to prevent.
export async function selectAll<T>(page: (from: number, to: number) => PageResult): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) return rows
    rows.push(...(data as T[]))
  }
}

export function chunk<T>(items: T[], size = IN_BATCH_SIZE): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

// selectAll over an `.in()` filter, batching the id list so the URL stays short.
export async function selectAllIn<T>(
  ids: string[],
  page: (batch: string[], from: number, to: number) => PageResult
): Promise<T[]> {
  if (ids.length === 0) return []
  const batches = await Promise.all(
    chunk([...new Set(ids)]).map((batch) => selectAll<T>((from, to) => page(batch, from, to)))
  )
  return batches.flat()
}
