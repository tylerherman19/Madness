import Link from 'next/link'
import LogoMark from './LogoMark'
import { copyFor, type CompetitionMode } from '@/lib/competition'

// The brand block. MADNESS is permanent — it is the product's name in January
// and in March alike — and only the supporting line moves with the active
// competition ("College Basketball Survivor" / "Tournament Survivor").
//
// The navigation never says "March Madness Survivor": the site operates all
// season, and a permanent label that only makes sense for three weeks would
// make the other four months read like a staging environment.
export default function Wordmark({
  mode,
  href = '/',
  size = 64,
  showTagline = true,
}: {
  mode: CompetitionMode
  href?: string | null
  size?: number
  showTagline?: boolean
}) {
  const inner = (
    <span className="flex items-center gap-3">
      <LogoMark size={size} />
      <span className="flex flex-col leading-none">
        <span className="font-display text-white text-xl tracking-wider">MADNESS</span>
        {showTagline && (
          <span
            className="mt-1 text-[10px] tracking-[0.18em] uppercase"
            style={{ color: '#8a8a8a' }}
          >
            {copyFor(mode).tagline}
          </span>
        )}
      </span>
    </span>
  )

  if (!href) return inner
  return (
    <Link href={href} className="shrink-0">
      {inner}
    </Link>
  )
}
