export interface TeamBrand {
  abbreviation: string
  name: string
  shortName: string
  logo: string | null
  primary: string
  secondary: string
}

export type TeamBrandDirectory = Record<string, TeamBrand>

interface EspnTeam {
  abbreviation?: string
  displayName?: string
  shortDisplayName?: string
  color?: string
  alternateColor?: string
  logos?: Array<{ href?: string; rel?: string[] }>
}

// Fetched and cached on the server (lib/sharedData.ts). This module stays free
// of server code because client components use brandFor().
export const TEAM_DIRECTORY_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams?limit=500'

function safeHex(value: string | undefined, fallback: string): string {
  return value && /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : fallback
}

export function fallbackTeamColor(team: string): string {
  const palette = ['#173F35', '#244E8A', '#693572', '#8A2E34', '#9A4F18', '#3C5370', '#5C4A2C']
  let hash = 0
  for (const char of team) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

// ESPN's /teams payload, reduced to the fields the pages show.
export function parseTeamDirectory(payload: unknown): TeamBrandDirectory {
  const teams = ((payload as { sports?: { leagues?: { teams?: unknown[] }[] }[] })?.sports?.[0]?.leagues?.[0]?.teams ?? []) as Array<{ team?: EspnTeam }>
  const directory: TeamBrandDirectory = {}

  for (const row of teams) {
    const team = row.team
    const abbreviation = team?.abbreviation?.trim().toUpperCase()
    if (!team || !abbreviation) continue

    directory[abbreviation] = {
      abbreviation,
      name: team.displayName ?? abbreviation,
      shortName: team.shortDisplayName ?? team.displayName ?? abbreviation,
      logo: team.logos?.find((logo) => logo.rel?.includes('default'))?.href ?? team.logos?.[0]?.href ?? null,
      primary: safeHex(team.color, fallbackTeamColor(abbreviation)),
      secondary: safeHex(team.alternateColor, '#FFFFFF'),
    }
  }

  return directory
}

// Only the teams a page actually shows, so the browser isn't sent all ~360.
// A team missing from the directory is left out and renders through
// brandFor()'s fallback, exactly as it would with the full directory.
export function brandsFor(teams: Iterable<string | null | undefined>, directory: TeamBrandDirectory): TeamBrandDirectory {
  const subset: TeamBrandDirectory = {}
  for (const team of teams) {
    const abbreviation = team?.trim().toUpperCase()
    if (abbreviation && directory[abbreviation]) subset[abbreviation] = directory[abbreviation]
  }
  return subset
}

// Short display names for the same teams, for components that print names.
export function shortNamesOf(directory: TeamBrandDirectory): Record<string, string> {
  return Object.fromEntries(Object.entries(directory).map(([abbr, brand]) => [abbr, brand.shortName]))
}

export function brandFor(team: string, directory?: TeamBrandDirectory): TeamBrand {
  const abbreviation = team.trim().toUpperCase()
  return directory?.[abbreviation] ?? {
    abbreviation,
    name: abbreviation,
    shortName: abbreviation,
    logo: null,
    primary: fallbackTeamColor(abbreviation),
    secondary: '#FFFFFF',
  }
}
