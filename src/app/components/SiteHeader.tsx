'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import LogoutButton from './LogoutButton'
import type { CompetitionMode } from '@/lib/competition'
import { eventLabel, themeStyle } from '@/lib/poolTheme'
import { usePoolMode } from './PoolMode'
import s from './pp.module.css'

const links = [
  { href: '/', label: 'Today', shortLabel: 'Today' },
  { href: '/pick', label: 'Pick', shortLabel: 'Pick' },
  { href: '/sweat', label: 'Sweat board', shortLabel: 'Sweat' },
  { href: '/standings', label: 'Standings', shortLabel: 'Standings' },
  { href: '/rules', label: 'Rules', shortLabel: 'Rules' },
]

function isCurrent(path: string, href: string): boolean {
  if (href === '/') return path === '/'
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

function ProfileGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" strokeLinecap="round" />
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
  mode = mode ?? scope.mode
  seasonYear = seasonYear ?? scope.seasonYear
  const path = usePathname() ?? '/'
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const initials = account ? account.split(' ').map((name) => name[0]).slice(0, 2).join('').toUpperCase() : null
  const event = eventLabel(mode, seasonYear)
  const theme = themeStyle(mode)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <>
      <header className={s.header} style={theme}>
        <div className={s.headerInner}>
          <Link className={s.brand} href="/" aria-label="Pick and Pray, today">
            <LogoMark />
            <span className={s.brandName}>Pick and Pray</span>
          </Link>
          <nav className={s.nav} aria-label="Pool">
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
                {link.label}
              </Link>
            ))}
          </nav>
          <span className={s.event}>{event}</span>
          <div className={s.account} ref={menuRef}>
            <button
              type="button"
              className={s.avatar}
              aria-label={account ? `Account menu for ${account}` : 'Account menu'}
              aria-expanded={open}
              aria-controls="account-menu"
              onClick={() => setOpen(!open)}
            >
              {initials ?? <ProfileGlyph />}
            </button>
            {open && (
              <nav id="account-menu" className={s.menu} aria-label="Your entry" onClick={(event) => { if ((event.target as HTMLElement).closest('a')) setOpen(false) }}>
                {account && <div className={s.menuName}>{account}</div>}
                {account && <Link href="/history">Pick history</Link>}
                <Link href="/grid">Pick grid</Link>
                <Link href="/schedule">Schedule</Link>
                {account && <Link href="/notifications">Alerts</Link>}
                {account ? (
                  <LogoutButton />
                ) : (
                  <>
                    <Link href="/login">Log in</Link>
                    {!signupsClosed && <Link href="/signup">Join pool</Link>}
                  </>
                )}
              </nav>
            )}
          </div>
        </div>
        <div className={s.mobileEvent}>{event}</div>
      </header>

      <nav className={s.bottomNav} style={theme} aria-label="Sections">
        {links.map((link) => (
          <Link key={link.href} href={link.href} aria-current={isCurrent(path, link.href) ? 'page' : undefined}>
            {link.shortLabel}
          </Link>
        ))}
      </nav>
    </>
  )
}
