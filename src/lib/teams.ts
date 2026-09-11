import type { SupabaseClient } from '@supabase/supabase-js'

// College basketball has ~360 D1 programs and the set that matters changes
// with conference realignment, so there is no hard-coded roster to import the
// way the NFL pool listed its 32 teams. Teams are discovered from the ESPN
// scoreboard as games sync (see espnSync) and cached in the `teams` table.
//
// ESPN's /teams endpoint deliberately is not used: it ignores the `groups`
// filter and returns the same 100 teams for every conference id.

export type TeamNameMap = Record<string, string>

// Display name for a team, falling back to the abbreviation. Abbreviations
// are the normal way college teams are written on a scoreboard ("DUKE",
// "UNC"), so the fallback reads fine on its own.
export function teamLabel(abbr: string, names?: TeamNameMap): string {
  return names?.[abbr] ?? abbr
}

// All known teams, abbr -> display name. Server-side; pass the result down to
// client components rather than having each one query.
export async function getTeamNames(db: SupabaseClient): Promise<TeamNameMap> {
  const { data } = await db.from('teams').select('abbr, display_name')
  const map: TeamNameMap = {}
  for (const t of data ?? []) map[t.abbr] = t.display_name
  return map
}

// Abbreviations of every team seen so far, sorted. Used for admin pickers and
// for "teams still available" views.
export async function getTeamAbbrs(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('teams').select('abbr').order('abbr')
  return (data ?? []).map((t) => t.abbr)
}

// Teams playing on a given slate — the only legal picks for that slate.
export async function getSlateTeams(db: SupabaseClient, slateId: string): Promise<string[]> {
  const { data } = await db.from('games').select('home_team, away_team').eq('slate_id', slateId)
  const set = new Set<string>()
  for (const g of data ?? []) {
    set.add(g.home_team)
    set.add(g.away_team)
  }
  return [...set].sort()
}
