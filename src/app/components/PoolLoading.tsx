'use client'

import { themeStyle } from '@/lib/poolTheme'
import SiteHeader from './SiteHeader'
import { TickerSkeleton } from './PageSkeletons'
import { useRememberedMode } from './PoolMode'
import { Bone, SkeletonRegion, times } from './Skeleton'
import s from './pp.module.css'

type Variant = 'today' | 'pick' | 'sweat' | 'standings' | 'rules' | 'list' | 'page'

// Loading screens for the pool pages. Same frame and proportions as the real
// pages, in the last mode the visitor saw, so nothing jumps or changes color
// when the data arrives.
export default function PoolLoading({ variant = 'page' }: { variant?: Variant }) {
  const { mode } = useRememberedMode()
  const width = variant === 'standings' ? s.mainNarrow : variant === 'rules' ? s.mainMid : ''
  return (
    <div className={s.shell} style={themeStyle(mode)}>
      <SiteHeader />
      {variant !== 'page' && <TickerSkeleton />}
      <main id="main" className={`${s.main} ${width}`}>
        <SkeletonRegion label="Loading">
          <Bone w={220} h={14} />
          <Bone w={variant === 'today' ? 420 : 300} h={46} style={{ display: 'block', marginTop: 8, maxWidth: '100%' }} />
          {variant === 'today' && <TodayBody />}
          {variant === 'pick' && <PickBody />}
          {variant === 'sweat' && <SweatBody />}
          {variant === 'standings' && <ListBody rows={14} />}
          {variant === 'rules' && <ListBody rows={8} />}
          {variant === 'list' && <ListBody rows={10} />}
          {variant === 'page' && <ListBody rows={6} />}
        </SkeletonRegion>
      </main>
    </div>
  )
}

function DarkBand({ height }: { height: number }) {
  return <div className={s.loadBand} style={{ height }} />
}

function GameRows({ rows }: { rows: number }) {
  return (
    <>
      <div className={s.loadHead}><Bone w={160} h={24} /></div>
      {times(rows, (i) => (
        <div className={s.loadRow} key={i}>
          <Bone w={70} h={14} /><Bone w="60%" h={16} /><Bone w="60%" h={16} />
        </div>
      ))}
    </>
  )
}

function Aside() {
  return (
    <aside className={s.aside}>
      <div className={s.loadHead} style={{ borderBottom: 0 }}><Bone w={130} h={24} /></div>
      <div className={s.card}><Bone w={80} h={12} /><Bone w={160} h={30} style={{ display: 'block', marginTop: 8 }} /></div>
      <div className={s.loadBand} style={{ height: 50, marginTop: 12, opacity: .35 }} />
    </aside>
  )
}

function TodayBody() {
  return (
    <>
      <div style={{ marginTop: 22 }}><DarkBand height={98} /></div>
      <div style={{ marginTop: 28 }}><Bone w="100%" h={120} /></div>
      <div className={s.split}><section><GameRows rows={8} /></section><Aside /></div>
    </>
  )
}

function PickBody() {
  return (
    <div className={s.split} style={{ marginTop: 40 }}>
      <section>
        <div className={s.loadHead}><Bone w={160} h={24} /></div>
        <div className={s.pickGrid}>
          {times(8, (i) => (
            <div className={s.pickGame} key={i}>
              <Bone w={120} h={12} />
              <Bone w="70%" h={18} style={{ display: 'block', margin: '16px 0 0 34px' }} />
              <Bone w="60%" h={18} style={{ display: 'block', margin: '24px 0 6px 34px' }} />
            </div>
          ))}
        </div>
      </section>
      <Aside />
    </div>
  )
}

function SweatBody() {
  return (
    <>
      <div style={{ marginTop: 22 }}><DarkBand height={118} /></div>
      <div className={s.split} style={{ marginTop: 32 }}><section><GameRows rows={6} /></section><Aside /></div>
    </>
  )
}

function ListBody({ rows }: { rows: number }) {
  return (
    <div style={{ marginTop: 28 }}>
      <div className={s.loadHead}><Bone w={140} h={24} /></div>
      {times(rows, (i) => (
        <div className={s.loadRow} key={i}><Bone w="40%" h={16} /><Bone w={90} h={14} /><Bone w={140} h={14} /></div>
      ))}
    </div>
  )
}

// The sweat board's own placeholder while its live feed loads.
export function SweatBoardSkeleton() {
  return (
    <SkeletonRegion label="Loading the sweat board">
      <SweatBody />
    </SkeletonRegion>
  )
}
