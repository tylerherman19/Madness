import SiteHeader from '@/app/components/SiteHeader'
import { ScheduleSkeleton, TickerSkeleton } from '@/app/components/PageSkeletons'
import s from '@/app/components/sports.module.css'

export default function Loading() {
  return (
    <div className={s.root}>
      <SiteHeader />
      <TickerSkeleton />
      <main id="main" className={s.main}><ScheduleSkeleton /></main>
    </div>
  )
}
