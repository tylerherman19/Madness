import 'server-only'
import { getDb } from './testMode'

export interface ContestState {
  registered: number
  alive: number
  eliminated: number
  started: boolean
  stopped: boolean
}

// Survivor counts and whether the contest has started or stopped (every entry out after the start).
// Null when the database predates migration 033 or cannot answer.
export async function getContestState(): Promise<ContestState | null> {
  try {
    const { data, error } = await (await getDb()).rpc('contest_state')
    return error || !data ? null : (data as ContestState)
  } catch {
    return null
  }
}
