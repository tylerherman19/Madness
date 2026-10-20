'use client'

import { themeStyle } from '@/lib/poolTheme'
import SiteHeader from './SiteHeader'
import TrustFooter from './TrustFooter'
import { usePoolMode, useRememberedMode } from './PoolMode'
import s from './pp.module.css'

// Privacy, terms, contact and error pages: plain reading pages in the pool's
// theme. Inside a PoolThemeScope the live mode is known; error pages fall back
// to the last mode the visitor saw.
export default function InfoPage({ title, children }: { title: string; children: React.ReactNode }) {
  const scope = usePoolMode()
  const last = useRememberedMode()
  return (
    <div className={s.shell} style={themeStyle(scope.mode ?? last.mode)}>
      <SiteHeader />
      <main id="main" className={`${s.main} ${s.mainNarrow}`}>
        <h1 className={s.title}>{title}</h1>
        <div className={s.infoBody}>{children}</div>
      </main>
      <TrustFooter />
    </div>
  )
}
