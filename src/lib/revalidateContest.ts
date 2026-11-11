import 'server-only'
import { revalidatePath, revalidateTag } from 'next/cache'
import { CONTEST_TAG } from './cacheTags'

// Marks the server-cached contest data stale (lib/dashboard.ts, the signup
// cutoff, team conferences) so the next visitor reads fresh rows. Never
// throws: it can be reached while a page is rendering (the pick page syncs
// the next game day), where Next.js refuses revalidation. The cache's
// 60-second lifetime covers that case.
export function invalidateContestData(): void {
  try {
    revalidateTag(CONTEST_TAG, { expire: 0 })
  } catch (error) {
    console.warn('contest cache not invalidated:', error instanceof Error ? error.message : error)
  }
}

// Call after any write to contest data. A saved pick passes `picksOnly`: the
// shared copy of the active day (who has picked, and the teams once locked)
// refreshes every 10 seconds on its own, and a pick never changes the finished
// days, so the shared season cache needn't be thrown away on every pick. The
// pick's own player reads their pick fresh, never from a shared copy.
export function revalidateContest({ picksOnly = false }: { picksOnly?: boolean } = {}) {
  if (!picksOnly) invalidateContestData()
  for (const path of ['/', '/grid', '/sweat', '/pick', '/admin', '/admin/players']) revalidatePath(path)
}
