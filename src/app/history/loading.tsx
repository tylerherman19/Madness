import SiteHeader from '@/app/components/SiteHeader'
import { HistorySkeleton } from '@/app/components/PageSkeletons'

export default function Loading() {
  return (
    <div className="site-shell min-h-screen flex flex-col">
      <SiteHeader />
      <main id="main" className="flex-1 mx-auto w-full max-w-4xl px-4 py-10"><HistorySkeleton /></main>
    </div>
  )
}
