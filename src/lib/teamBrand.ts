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

const DIRECTORY_URL =
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

export async function getTeamBrandDirectory(): Promise<TeamBrandDirectory> {
  try {
    const response = await fetch(DIRECTORY_URL, { next: { revalidate: 86_400 } })
    if (!response.ok) return {}

    const payload = await response.json()
    const teams = (payload?.sports?.[0]?.leagues?.[0]?.teams ?? []) as Array<{ team?: EspnTeam }>
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
  } catch {
    return {}
  }
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
