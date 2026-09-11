import { brandFor, fallbackTeamColor, type TeamBrandDirectory } from './teamBrand'

export interface TeamColor {
  primary: string
}

export function teamColor(team: string | null | undefined, directory?: TeamBrandDirectory): TeamColor {
  if (!team) return { primary: '#173F35' }
  if (directory) return { primary: brandFor(team, directory).primary }
  return { primary: fallbackTeamColor(team) }
}
