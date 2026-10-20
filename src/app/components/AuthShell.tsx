'use client'

import SiteHeader from './SiteHeader'
import TrustFooter from './TrustFooter'
import s from './pp.module.css'

// Log in, sign up and password screens. The surrounding PoolThemeScope sets
// the mode colors; this lays out the form beside a short how-it-works panel.
export default function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <>
      <SiteHeader />
      <main id="main" className={`${s.main} ${s.mainMid}`}>
        <div className={s.authGrid}>
          <section className={s.authForm}>
            <h1 className={s.title}>{title}</h1>
            {description && <p className={s.authLede}>{description}</p>}
            <div className={s.authBody}>{children}</div>
          </section>
          <aside className={s.authGuide} aria-label="How it works">
            <h2>How it works</h2>
            <ol>
              {[
                ['Pick', 'Choose one team playing that day.'],
                ['Lock', 'Picks lock at the first tip. Change yours until then.'],
                ['Win', 'Your team wins. You play the next day.'],
                ['Lose', 'Your team loses. Your entry is out.'],
              ].map(([label, text], index) => (
                <li key={label}>
                  <small>Step {index + 1}</small>
                  <b>{label}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </main>
      <TrustFooter />
    </>
  )
}
