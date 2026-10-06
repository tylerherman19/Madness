import SiteHeader from '@/app/components/SiteHeader'
import { GridSkeleton } from '@/app/components/PageSkeletons'

export default function Loading() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main id="main" className="content-width py-9 sm:py-12"><GridSkeleton /></main>
    </div>
  )
}
