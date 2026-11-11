import 'server-only'
import { unstable_cache } from 'next/cache'
import { getDb } from './testMode'
import { CONTEST_TAG } from './cacheTags'
import { clientFor, schemaOf, type Schema } from './sharedData'

export interface ContestState {
  registered: number
  alive: number
  eliminated: number
  started: boolean
  stopped: boolean
}

// The same for every visitor, so it is read once per few seconds and shared
// (invalidated with the rest of the contest data). The function is bound so its
// cache key does not depend on the bundle it was compiled into; throwing keeps
// a failed read out of the cache.
const cachedState = unstable_cache(
  (async (schema: Schema): Promise<ContestState> => {
    const { data, error } = await clientFor(schema).rpc('contest_state')
    if (error || !data) throw error ?? new Error('no contest state')
    return data as ContestState
  }).bind(null),
  ['contest-state-v1'],
  { tags: [CONTEST_TAG], revalidate: 10 }
)

// Survivor counts and whether the contest has started or stopped (every entry out after the start).
// Null when the database predates migration 033 or cannot answer.
export async function getContestState(): Promise<ContestState | null> {
  try {
    return await cachedState(schemaOf(await getDb()))
  } catch {
    return null
  }
}
