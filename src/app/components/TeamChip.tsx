import type { TeamBrandDirectory } from '@/lib/teamBrand'
import TeamMark from './TeamMark'

// Server-safe team token: color swatch + abbreviation, optional full name.
export default function TeamChip({
  team,
  showName,
  size = 20,
  directory,
}: {
  team: string
  showName?: boolean
  size?: number
  directory?: TeamBrandDirectory
}) {
  return <TeamMark team={team} showName={showName} size={size} directory={directory} compact={!showName} />
}
