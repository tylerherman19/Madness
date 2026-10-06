import SiteHeader from '@/app/components/SiteHeader'
import { StandingsSkeleton } from '@/app/components/PageSkeletons'

export default function Loading() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main id="main" className="content-width dashboard-content pb-4"><StandingsSkeleton /></main>
    </div>
  )
}
