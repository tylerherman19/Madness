'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import BrandMark from './BrandMark'
import LogoutButton from './LogoutButton'
import type { CompetitionMode } from '@/lib/competition'
import type { PickState, Viewer } from '@/lib/viewerState'
import { themeStyle } from '@/lib/poolTheme'
import { rememberMode, usePoolMode, useRememberedMode } from './PoolMode'
import { useViewer } from './useViewer'
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

// The header's one action, from where the visitor's entry stands.
function actionFor(viewer: Viewer | undefined): { href: string; label: string } | null | undefined {
  if (!viewer) return undefined // still finding out
  if (!viewer.name) return { href: '/login', label: 'Log in' }
  const byState: Record<PickState, { href: string; label: string } | null> = {
    open: { href: '/pick', label: 'Make your pick' },
    submitted: { href: '/pick', label: 'Change pick' },
    locked: { href: '/sweat', label: 'View picks' },
    eliminated: { href: '/sweat', label: 'View picks' },
    none: null,
  }
  return viewer.pick ? byState[viewer.pick] : undefined
}

export default function SiteHeader({
  signupsClosed,
  mode,
  seasonYear,
  account,
  pick,
  hideAction = false,
}: {
  signupsClosed?: boolean // when the page read it; otherwise the header asks
  mode?: CompetitionMode
  seasonYear?: number | null
  // The signed-in name when the page read the session (null: signed out).
  // Left out on pages built ahead for everyone; the header then asks.
  account?: string | null
  pick?: PickState
  // The page shows the same action itself (Today's entry strip).
  hideAction?: boolean
}) {
  const scope = usePoolMode()
  const last = useRememberedMode()
  const knownMode = mode ?? scope.mode
  const knownYear = seasonYear ?? scope.seasonYear
  // Loading screens know nothing yet; they borrow the last page's colors.
  const shownMode = knownMode ?? last.mode
  useEffect(() => {
    if (knownMode) rememberMode(knownMode, knownYear)
  }, [knownMode, knownYear])
  const viewer = useViewer(account === undefined ? undefined : { name: account, pick, signupsClosed })
  const path = usePathname() ?? '/'
  const [menuOpen, setMenuOpen] = useState(false)
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

  const signedIn = !!viewer?.name
  const found = actionFor(viewer)
  const action = found && !hideAction && found.href !== path ? found : null
  const closed = signupsClosed ?? viewer?.signupsClosed ?? true
  const join = viewer && !signedIn && !closed
    ? <Link href="/signup" aria-current={path === '/signup' ? 'page' : undefined}>Join pool</Link>
    : null
  const logout = signedIn ? <LogoutButton /> : null

  return (
    <header className={s.header} style={theme}>
      <div className={s.headerInner}>
        <Link className={s.brand} href="/" aria-label="Pick and Pray, home">
          <BrandMark />
          <span className={s.brandName}>Pick and Pray</span>
        </Link>
        <nav className={s.nav} aria-label="Pool">
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}
          {join}
          {logout}
        </nav>
        {action
          ? <Link className={s.headerAction} href={action.href}>{action.label}</Link>
          : found === undefined && !hideAction
            ? <span className={`${s.headerAction} ${s.headerActionPending}`} aria-hidden="true" />
            : null}
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
      {menuOpen && (
        <nav id="site-menu" className={s.siteMenu} aria-label="Menu" onClick={closeOnLink}>
          {signedIn && <div className={s.siteMenuName}>Signed in as {viewer?.name}</div>}
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}
          {join}
          {logout}
        </nav>
      )}
    </header>
  )
}
