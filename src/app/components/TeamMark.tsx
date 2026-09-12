import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'

export default function TeamMark({
  team,
  directory,
  size = 34,
  showName = false,
  compact = false,
}: {
  team: string
  directory?: TeamBrandDirectory
  size?: number
  showName?: boolean
  compact?: boolean
}) {
  const brand = brandFor(team, directory)

  return (
    <span className="team-mark" style={{ '--team': brand.primary } as React.CSSProperties}>
      <span className="team-mark-logo" style={{ width: size, height: size }}>
        {brand.logo ? (
          // ESPN provides the same public marks used in its scoreboard feed.
          // The plain image element keeps the component resilient if the CDN
          // host changes; the text fallback still identifies the team.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logo} alt="" width={size} height={size} loading="lazy" />
        ) : (
          <span aria-hidden="true" style={{ color: brand.primary }}>{brand.abbreviation.slice(0, 3)}</span>
        )}
      </span>
      <span className="team-mark-copy">
        <strong>{brand.abbreviation}</strong>
        {showName && !compact && brand.shortName !== brand.abbreviation && <small>{brand.shortName}</small>}
      </span>
    </span>
  )
}
