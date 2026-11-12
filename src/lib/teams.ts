import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAll } from './db'

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
  const data = await selectAll<{ abbr: string; display_name: string }>((from, to) =>
    db.from('teams').select('abbr, display_name').order('abbr').range(from, to)
  )
  const map: TeamNameMap = {}
  for (const t of data) map[t.abbr] = t.display_name
  return map
}

// Abbreviations of every team seen so far, sorted. Used for admin pickers and
// for "teams still available" views.
export async function getTeamAbbrs(db: SupabaseClient): Promise<string[]> {
  const data = await selectAll<{ abbr: string }>((from, to) =>
    db.from('teams').select('abbr').order('abbr').range(from, to)
  )
  return data.map((t) => t.abbr)
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

// Abbreviations that appear more than once among a day's games. Picks,
// grading and the boards name a team by abbreviation within a day, so when two
// schools share one (or a feed lists a team twice) the abbreviation no longer
// identifies a single game. Callers refuse to grade or match those games.
export function ambiguousAbbreviations(games: { home_team: string; away_team: string }[]): Set<string> {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const game of games) {
    for (const team of [game.home_team, game.away_team]) {
      if (!team) continue
      if (seen.has(team)) ambiguous.add(team)
      seen.add(team)
    }
  }
  return ambiguous
}

// Conference per team, for grouping regular-season games.
export async function getTeamConferences(db: SupabaseClient): Promise<Record<string, string>> {
  const data = await selectAll<{ abbr: string; conference: string | null }>((from, to) =>
    db.from('teams').select('abbr, conference').order('abbr').range(from, to)
  )
  const map: Record<string, string> = {}
  for (const t of data) if (t.conference) map[t.abbr] = t.conference
  return map
}

// The label for a game's group in the regular season: the shared conference,
// or "Non-conference" when the two teams come from different ones.
export function conferenceGroup(away: string, home: string, conferences: Record<string, string>): string | null {
  const a = conferences[away]
  const h = conferences[home]
  if (a && h) return a === h ? a : 'Non-conference'
  return a ?? h ?? null
}
