'use client'

import { useEffect, useRef, useState } from 'react'
import s from '@/app/components/pp.module.css'

// The pick grid's scrolling frame. Opens scrolled so today and the next day
// sit at the right edge with the days before them in view; later days are
// one tap away; a fade on the right edge (and a line of text) says there is
// more to scroll to. The whole season stays in the table.
export default function GridScroller({ laterCount, label, children }: { laterCount: number; label: string; children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [showLater, setShowLater] = useState(false)
  const [more, setMore] = useState({ left: false, right: false })

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => { el.removeEventListener('scroll', measure); window.removeEventListener('resize', measure) }
  }, [showLater])

  // Once, on arrival: bring today into view.
  useEffect(() => {
    const el = wrap.current
    const today = el?.querySelector<HTMLElement>('thead th[data-current=true]')
    if (!el || !today) return
    const next = today.nextElementSibling as HTMLElement | null
    const target = today.offsetLeft + today.offsetWidth + (next && !next.dataset.later ? next.offsetWidth : 0) - el.clientWidth + 8
    el.scrollLeft = Math.max(0, target)
  }, [])

  return (
    <>
      <div className={s.gridTools}>
        {(more.left || more.right) && <span className={s.small}>Scroll sideways to see every day.</span>}
        {laterCount > 0 && (
          <button type="button" className={s.textButton} aria-expanded={showLater} onClick={() => setShowLater(!showLater)}>
            {showLater ? 'Hide later days' : `Show ${laterCount} later ${laterCount === 1 ? 'day' : 'days'}`}
          </button>
        )}
      </div>
      <div className={s.gridFrame} data-more-right={more.right}>
        <div ref={wrap} className={s.gridWrap} data-show-later={showLater} role="region" aria-label={label} tabIndex={0}>
          {children}
        </div>
      </div>
    </>
  )
}
