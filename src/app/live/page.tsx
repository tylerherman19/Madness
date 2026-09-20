import SweatBoard from './SweatBoard'
import SiteHeader from '@/app/components/SiteHeader'
import { getPoolConfig } from '@/lib/pool'
import { getTeamBrandDirectory } from '@/lib/teamBrand'
import { Footer } from '@/app/components/Sports'
import LiveTicker from '@/app/components/LiveTicker'

export const metadata = { title: 'Sweat Board — MADNESS' }

// The shell reads the pool's competition mode, so it can't be baked in at
// build time and left there — a format switch has to reach this page. The
// board itself is a client component polling /api/sweat, so a minute-stale
// shell costs nothing.
export const revalidate = 60

export default async function LivePage() {
  // The sweat board runs year-round; the header just has to agree with the
  // competition the pool is actually playing.
  const [pool, teamBrands] = await Promise.all([
    getPoolConfig(),
    getTeamBrandDirectory(),
  ])
  const mode = pool.competition_mode

  return (
    <div className="site-shell">
      <SiteHeader mode={mode} />
      <LiveTicker />

      <main className="content-width py-9 pb-16">
        <SweatBoard teamBrands={teamBrands} autoPickBehavior={pool.auto_pick_behavior} />
      </main>
      <Footer />
    </div>
  )
}
