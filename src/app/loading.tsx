import SiteHeader from './components/SiteHeader'
import { HomeSkeleton, TickerSkeleton } from './components/PageSkeletons'
import s from './components/sports.module.css'

export default function Loading() {
  return (
    <div className={s.root}>
      <SiteHeader />
      <TickerSkeleton />
      <main id="main" className={s.main}><HomeSkeleton /></main>
    </div>
  )
}
