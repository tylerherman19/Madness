import SiteHeader from '@/app/components/SiteHeader'
import { LiveBoardSkeleton, TickerSkeleton } from '@/app/components/PageSkeletons'

export default function Loading() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <TickerSkeleton />
      <main id="main" className="content-width py-9 pb-16"><LiveBoardSkeleton /></main>
    </div>
  )
}
