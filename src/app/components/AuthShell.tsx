'use client'

import SiteHeader from './SiteHeader'
import TrustFooter from './TrustFooter'
import s from './pp.module.css'

// Log in, sign up and password screens: one narrow column with the form
// first. The surrounding PoolThemeScope sets the season's colors. `links` are
// the screen's secondary routes, all in one style under the form; `guide`
// adds the four-line summary of how the pool works.
export default function AuthShell({
  title,
  description,
  links,
  guide = false,
  children,
}: {
  title: string
  description?: React.ReactNode
  links?: React.ReactNode[]
  guide?: boolean
  children: React.ReactNode
}) {
  const shown = (links ?? []).filter(Boolean)
  return (
    <>
      {/* The form is the screen's one action; the header doesn't repeat it. */}
      <SiteHeader hideAction />
      <main id="main" className={`${s.main} ${s.mainNarrow}`}>
        <section className={s.authForm}>
          <h1 className={s.title}>{title}</h1>
          {description && <p className={s.authLede}>{description}</p>}
          <div className={s.authBody}>{children}</div>
          {shown.length > 0 && (
            <ul className={s.authLinks}>
              {shown.map((link, index) => <li key={index}>{link}</li>)}
            </ul>
          )}
          {guide && (
            <section className={s.authGuide} aria-labelledby="how-it-works">
              <h2 id="how-it-works">How it works</h2>
              <dl>
                {[
                  ['Pick', 'Choose one team playing that day.'],
                  ['Lock', 'Picks lock at the first tip. Change yours until then.'],
                  ['Win', 'Your team wins and you play the next day.'],
                  ['Lose', 'Your team loses and your entry is out.'],
                ].map(([label, text]) => (
                  <div key={label}><dt>{label}</dt><dd>{text}</dd></div>
                ))}
              </dl>
            </section>
          )}
        </section>
      </main>
      <TrustFooter />
    </>
  )
}
