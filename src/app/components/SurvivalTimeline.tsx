'use client'

import { useState } from 'react'
import type { TimelineColumn } from '@/lib/timeline'
import s from './pp.module.css'

// Today's survival timeline: entries remaining after each game day. Shows the
// completed days, today and the next game day; later days on request.
export default function SurvivalTimeline({ columns, max }: { columns: TimelineColumn[]; max: number }) {
  const [showLater, setShowLater] = useState(false)
  const laterCount = columns.filter((c) => c.later).length
  const shown = showLater ? columns : columns.filter((c) => !c.later)
  const grid = { gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }
  return (
    <section className={s.timeline} aria-label="Survival timeline">
      <div className={s.timelineHead}>
        <h2>Survival timeline</h2>
        <span>Entries remaining after each day</span>
        {laterCount > 0 && (
          <button type="button" className={s.textButton} aria-expanded={showLater} onClick={() => setShowLater(!showLater)}>
            {showLater ? 'Hide later days' : 'Show later days'}
          </button>
        )}
      </div>
      <div className={s.tlBars} style={grid}>
        {shown.map((col) => (
          <div className={s.tlCol} data-state={col.state} key={col.key}>
            <span className={s.tlNum}>{col.remaining ?? ''}{col.state === 'today' && <small> Pending</small>}</span>
            <span className={s.tlBar} style={{ '--r': col.remaining == null ? 0 : col.remaining / max } as React.CSSProperties} />
          </div>
        ))}
      </div>
      <div className={s.tlLabels} style={grid}>
        {shown.map((col) => (
          <div className={s.tlLabel} data-state={col.state} key={col.key}>{col.label}<small>{col.date}</small></div>
        ))}
      </div>
    </section>
  )
}
