import SweatBoard from './SweatBoard'
import SiteHeader from '@/app/components/SiteHeader'
import { getPoolConfig } from '@/lib/pool'
import { getTeamBrandDirectory } from '@/lib/teamBrand'

export const metadata = { title: 'Sweat Board — MADNESS' }

// The shell reads the pool's competition mode, so it can't be baked in at
// build time and left there — a format switch has to reach this page. The
// board itself is a client component polling /api/sweat, so a minute-stale
// shell costs nothing.
export const revalidate = 60

export default async function LivePage() {
  // The sweat board runs year-round; the header just has to agree with the
  // competition the pool is actually playing.
  const [{ competition_mode: mode }, teamBrands] = await Promise.all([
    getPoolConfig(),
    getTeamBrandDirectory(),
  ])

  return (
    <div className="site-shell">
      <SiteHeader mode={mode} />

      <main className="content-width pb-16">
        <SweatBoard teamBrands={teamBrands} />
      </main>
    </div>
  )
}
