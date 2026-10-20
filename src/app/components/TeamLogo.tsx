/* eslint-disable @next/next/no-img-element -- ESPN serves small team marks; the optimizer adds nothing here. */
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import s from './pp.module.css'

// A school's mark, or its abbreviation on its own color when ESPN has none.
export default function TeamLogo({ team, brands, src, size = 22 }: { team: string; brands?: TeamBrandDirectory; src?: string | null; size?: number }) {
  const brand = brandFor(team, brands)
  const logo = src ?? brand.logo
  return (
    <span className={s.logo} style={{ width: size, height: size, '--team': brand.primary } as React.CSSProperties} aria-hidden="true">
      {logo ? <img src={logo} alt="" width={size} height={size} loading="lazy" /> : <b style={{ fontSize: Math.max(7, Math.round(size * 0.32)) }}>{brand.abbreviation.slice(0, 4)}</b>}
    </span>
  )
}
