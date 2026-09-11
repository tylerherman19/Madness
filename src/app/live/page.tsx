import Link from 'next/link'
import SweatBoard from './SweatBoard'
import Wordmark from '@/app/components/Wordmark'
import { getPoolConfig } from '@/lib/pool'

export const metadata = { title: 'Sweat Board — MADNESS' }

// The shell reads the pool's competition mode, so it can't be baked in at
// build time and left there — a format switch has to reach this page. The
// board itself is a client component polling /api/sweat, so a minute-stale
// shell costs nothing.
export const revalidate = 60

export default async function LivePage() {
  // The sweat board runs year-round; the header just has to agree with the
  // competition the pool is actually playing.
  const { competition_mode: mode } = await getPoolConfig()

  return (
    <div style={{ background: 'var(--cream)', minHeight: '100vh' }}>
      <header style={{ background: 'var(--dark)' }}>
        <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between gap-4">
          <Wordmark mode={mode} />
          <nav className="flex items-center gap-4 sm:gap-6 shrink-0">
            <Link href="/" className="text-xs tracking-widest uppercase text-gray-400 hover:text-white transition-colors">Standings</Link>
            <Link href="/schedule" className="hidden sm:inline text-xs tracking-widest uppercase text-gray-400 hover:text-white transition-colors">Schedule</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16">
        <SweatBoard />
      </main>
    </div>
  )
}
