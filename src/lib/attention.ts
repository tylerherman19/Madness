import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface StalledGame {
  game_id: string
  slate_id: string
  slate_number: number
  home_team: string
  away_team: string
  tip_time: string
  hours_late: number
  home_picks: number
  away_picks: number
}

export interface WrongfullyEliminated {
  player_id: string
  name: string
  slate_number: number
  reason: string | null
}

export interface ResultsAttention {
  stalled: StalledGame[]
  restore: WrongfullyEliminated[]
  count: number
}

// Items the organizer should look at on the results page: games still pending more than six hours
// after tip, and entries grading eliminated whose losing result was later corrected after a later
// day had locked (restore by hand). Databases without migration 033 report nothing.
export async function getResultsAttention(db: SupabaseClient): Promise<ResultsAttention> {
  const empty: ResultsAttention = { stalled: [], restore: [], count: 0 }
  const { data, error } = await db.rpc('results_attention')
  if (error || !data) return empty
  return data as ResultsAttention
}
