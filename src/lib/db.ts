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

type Page = { data: unknown[] | null; error: PostgrestError | null; count?: number | null }
type PageResult = PromiseLike<Page>

// Ask PostgREST for the exact row total alongside the first page. supabase-js
// query builders support this; anything else (plain promises in tests) is
// read without a total and falls back to walking pages until one is empty.
function withTotal(query: PageResult): PageResult {
  const builder = query as PageResult & { setHeader?: (name: string, value: string) => unknown }
  if (typeof builder.setHeader === 'function') builder.setHeader('Prefer', 'count=exact')
  return query
}

function append<T>(rows: T[], page: Page): void {
  if (page.error) throw page.error
  rows.push(...((page.data ?? []) as T[]))
}

// Read every row. The first page carries the exact total, so the rest can be
// requested together instead of one after another, and no trailing empty page
// is needed to prove the end. The first page's length is the server's real
// page size, which keeps this correct when Max Rows is set below PAGE_SIZE.
// Whenever the pages disagree with the total (rows changed mid-read) or no
// total is available, it finishes the old way: walking pages until one comes
// back empty. Errors throw: a partial result that looks complete is exactly
// the failure this exists to prevent.
async function readPages<T>(page: (from: number, to: number) => PageResult, parallel: boolean): Promise<T[]> {
  const rows: T[] = []
  const first = await withTotal(page(0, PAGE_SIZE - 1))
  append(rows, first)
  if (rows.length === 0) return rows
  let total = typeof first.count === 'number' ? first.count : null
  if (total !== null && rows.length >= total) return rows

  if (parallel && total !== null) {
    const size = rows.length
    const queries: PageResult[] = []
    for (let from = size; from < total; from += size) queries.push(page(from, from + size - 1))
    // A callback that hands back one shared query builder cannot be read in
    // parallel — every request would see the last range set on it.
    if (new Set(queries).size === queries.length) {
      for (const result of await Promise.all(queries)) append(rows, result)
      if (rows.length >= total) return rows
      total = null
    }
  }

  for (;;) {
    const result = await page(rows.length, rows.length + PAGE_SIZE - 1)
    if (result.error) throw result.error
    if (!result.data || result.data.length === 0) return rows
    rows.push(...(result.data as T[]))
    if (total !== null && rows.length >= total) return rows
  }
}

// Fetch every row of a query. `page` must build a fresh query for each call.
export async function selectAll<T>(page: (from: number, to: number) => PageResult): Promise<T[]> {
  return readPages<T>(page, true)
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

// Preserve the typed {data,error} shape for existing page loaders while paging.
// The caller's query is one builder, so its pages are read one at a time.
export async function allRows<T>(query:{order(column:string):{range(from:number,to:number):PromiseLike<{data:T[]|null;error:PostgrestError|null}>}}) {
 const ordered=query.order('id')
 const data=await readPages<T>((from,to)=>ordered.range(from,to),false)
 return {data,error:null}
}
