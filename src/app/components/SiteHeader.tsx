'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import LogoutButton from './LogoutButton'
import type { CompetitionMode } from '@/lib/competition'
import { eventLabel, themeStyle } from '@/lib/poolTheme'
import { lastAccount, rememberAccount, rememberMode, usePoolMode, useRememberedMode } from './PoolMode'
import s from './pp.module.css'

// Same links on every screen size: across the top on a computer, in the menu
// on a phone. Standings and Rules are sections of the home page.
const links = [
  { href: '/#standings', label: 'Standings' },
  { href: '/#rules', label: 'Rules' },
  { href: '/grid', label: 'Pick grid' },
  { href: '/schedule', label: 'Schedule' },
  { href: '/sweat', label: 'Sweat board' },
]

function isCurrent(path: string, href: string): boolean {
  if (href.startsWith('/#')) return false
  if (href === '/sweat') return path === '/sweat' || path === '/live'
  return path === href || path.startsWith(`${href}/`)
}

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="510 180 460 460" aria-hidden="true">
      <polygon points="548,195 872,195 956,281 872,370 663,370 608,577 528,626 620,316 852,316 884,281 852,250 603,250" fill="#F3EFE3" />
      <polygon points="701,404 747,404 692,577 633,626" fill="#8FB07F" />
      <text x="748" y="542" fontFamily="Source Sans 3, sans-serif" fontWeight="700" fontSize="150" fill="#8FB07F">&amp;</text>
    </svg>
  )
}

export default function SiteHeader({
  signupsClosed = false,
  mode,
  seasonYear,
  account,
}: {
  signupsClosed?: boolean
  mode?: CompetitionMode
  seasonYear?: number | null
  account?: string
}) {
  const scope = usePoolMode()
  const last = useRememberedMode()
  const knownMode = mode ?? scope.mode
  const knownYear = seasonYear ?? scope.seasonYear
  // Loading screens know nothing yet; they borrow the last page's values.
  const shownMode = knownMode ?? last.mode
  const shownYear = knownMode ? knownYear : last.seasonYear
  const shownAccount = knownMode ? account : account ?? lastAccount()
  useEffect(() => {
    if (!knownMode) return
    rememberMode(knownMode, knownYear)
    rememberAccount(account)
  }, [knownMode, knownYear, account])
  const path = usePathname() ?? '/'
  const [menuOpen, setMenuOpen] = useState(false)
  const event = eventLabel(shownMode, shownYear)
  const theme = themeStyle(shownMode)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [menuOpen])

  // Phone menu: closes itself when any link in it is followed.
  const closeOnLink = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) setMenuOpen(false)
  }

  const accountLink = shownAccount ? <LogoutButton /> : <Link href="/login" aria-current={path === '/login' ? 'page' : undefined}>Log in</Link>

  return (
    <>
      <header className={s.header} style={theme}>
        <div className={s.headerInner}>
          <Link className={s.brand} href="/" aria-label="Pick and Pray, home">
            <LogoMark />
            <span className={s.brandName}>Pick and Pray</span>
          </Link>
          <nav className={s.nav} aria-label="Pool">
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
                {link.label}
              </Link>
            ))}
            {accountLink}
          </nav>
          <Link className={s.submitPick} href="/pick" aria-current={path === '/pick' ? 'page' : undefined}>Submit pick</Link>
          <button
            type="button"
            className={s.menuButton}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <span /><span /><span />
          </button>
        </div>
        <div className={s.mobileEvent}>{event}</div>
        {menuOpen && (
          <nav id="site-menu" className={s.siteMenu} aria-label="Menu" onClick={closeOnLink}>
            {shownAccount && <div className={s.siteMenuName}>{shownAccount}</div>}
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
                {link.label}
              </Link>
            ))}
            {accountLink}
            {!shownAccount && !signupsClosed && <Link href="/signup">Join pool</Link>}
          </nav>
        )}
      </header>
    </>
  )
}
