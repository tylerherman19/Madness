import SiteHeader from '@/app/components/SiteHeader'
import { LiveBoardSkeleton, TickerSkeleton } from '@/app/components/PageSkeletons'
import s from '@/app/components/pp.module.css'

export default function Loading() {
  return (
    <div className={s.shell}>
      <SiteHeader />
      <TickerSkeleton />
      <main id="main" className={s.main}><LiveBoardSkeleton /></main>
    </div>
  )
}
