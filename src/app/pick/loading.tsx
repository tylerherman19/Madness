import SiteHeader from '@/app/components/SiteHeader'
import { PickSkeleton } from '@/app/components/PageSkeletons'

export default function Loading() {
  return (
    <div className="site-shell flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="content-width flex-1 py-8 sm:py-10"><PickSkeleton /></main>
    </div>
  )
}
