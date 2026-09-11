import { teamColor } from '@/lib/teamColors'

// Server-safe team token: color swatch + abbreviation, optional full name.
export default function TeamChip({ team, showName, size = 20 }: { team: string; showName?: boolean; size?: number }) {
  const c = teamColor(team).primary
  return (
    <span className="team-chip text-sm" style={{ color: 'var(--dark)' }}>
      <span className="team-chip-swatch" style={{ background: c, width: size, height: size }}>{team.slice(0, 3)}</span>
      <span className="font-bold">{team}</span>
    </span>
  )
}
