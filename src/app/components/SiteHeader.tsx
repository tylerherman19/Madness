'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import LogoutButton from './LogoutButton'
import type { CompetitionMode } from '@/lib/competition'
import s from './sports.module.css'

const links = [
  { href: '/', label: 'Home', shortLabel: 'Home', icon: 'M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z' },
  { href: '/pick', label: 'Make pick', shortLabel: 'Pick', icon: 'M5 13.5 9.2 18 19 7.5M4 4h16v16H4z' },
  { href: '/schedule', label: 'Games', shortLabel: 'Games', icon: 'M5 3v3m14-3v3M4 8h16v12H4zM8 12h3m2 0h3m-8 4h3' },
  { href: '/live', label: 'Live board', shortLabel: 'Live', icon: 'M4 17.5 8.5 8l4 7 3.5-11 4 13.5M4 21h16' },
  { href: '/standings', label: 'Standings', shortLabel: 'Standings', icon: 'M5 20v-7h4v7m2 0V5h4v15m2 0v-10h4v10M3 20h20' },
]

function BrandLockup() {
  return (
    <span className={s.brandLockupWrap}>
      <svg className={s.brandIcon} viewBox="0 0 42 42" fill="none" aria-hidden="true">
        <path d="M5 7h9v6h7v7h8v8h8" stroke="currentColor" strokeWidth="4" />
        <path d="M5 17h7v7H5m0 4h9v7H5" stroke="#4e84d8" strokeWidth="4" />
      </svg>
      <span className={s.brandLockup}>MADNESS<small>PICK &amp; PRAY</small></span>
    </span>
  )
}

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ProfileGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6" strokeLinecap="round" />
    </svg>
  )
}

export default function SiteHeader({
  signupsClosed = false,
  mode = 'regular-season',
  account,
}: {
  signupsClosed?: boolean
  mode?: CompetitionMode
  account?: string
}) {
  const path = usePathname()
  const [desktopAccountOpen, setDesktopAccountOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false)
  const initials = account ? account.split(' ').map((name) => name[0]).slice(0, 2).join('') : null

  const closeMobilePanels = () => {
    setMobileMenuOpen(false)
    setMobileAccountOpen(false)
  }

  const accountLinks = (id: string, onNavigate?: () => void) => (
    <nav id={id} className="account-links" aria-label="Your entry">
      <Link href="/pick" onClick={onNavigate}>Your daily pick</Link>
      <Link href="/history" onClick={onNavigate}>Pick history &amp; alerts</Link>
      <Link href="/grid" onClick={onNavigate}>Full pick grid</Link>
      <Link href="/standings#rules" onClick={onNavigate}>Pool rules</Link>
      {account ? <LogoutButton /> : <><Link href="/login" onClick={onNavigate}>Log in</Link>{!signupsClosed && <Link href="/signup" onClick={onNavigate}>Join pool</Link>}</>}
    </nav>
  )

  return (
    <>
      <header className={`${s.header} app-side-rail`}>
        <div className={s.headerInner}>
          <Link className={s.wordmark} href="/" aria-label="Madness overview"><BrandLockup /></Link>
          <span className={s.modeBadge}>{mode === 'march-madness' ? 'March Madness' : 'Regular season'}</span>
          <p className={s.railLabel}>Pool navigation</p>
          <nav className={s.desktopNav} aria-label="Main navigation">
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={path === link.href ? 'page' : undefined}>
                <NavIcon path={link.icon} />
                <span>{link.label}</span>
              </Link>
            ))}
            <Link href="/history" aria-current={path === '/history' ? 'page' : undefined}>
              <NavIcon path="M6 4h12v16H6zM9 8h6m-6 4h6m-6 4h4" />
              <span>My entry</span>
            </Link>
            <Link href="/standings#rules">
              <NavIcon path="M12 17v.01M9.5 9.2a2.6 2.6 0 1 1 4.1 2.1c-1 .7-1.6 1.2-1.6 2.2M4 4h16v16H4z" />
              <span>Rules</span>
            </Link>
          </nav>
          <div className={s.railFootnote}><span>Real games.</span><span>Real odds.</span><span>A bigger story.</span></div>
          <div className={`${s.accountMenu} account-menu`}>
            <button className={s.profile} aria-expanded={desktopAccountOpen} aria-controls="desktop-account-links" onClick={() => setDesktopAccountOpen(!desktopAccountOpen)}>
              <span className={s.avatar}>{initials ?? <ProfileGlyph />}</span>
              <span>{account ?? 'My entry'}</span>
            </button>
            {desktopAccountOpen && accountLinks('desktop-account-links')}
          </div>
        </div>
      </header>

      <header className={s.mobileHeader}>
        <button
          className={s.mobileMenuButton}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-navigation-menu"
          onClick={() => {
            setMobileMenuOpen(!mobileMenuOpen)
            setMobileAccountOpen(false)
          }}
        >
          <span /><span /><span />
        </button>
        <Link className={s.mobileWordmark} href="/" aria-label="Madness overview" onClick={closeMobilePanels}><BrandLockup /></Link>
        <button
          className={s.mobileAvatar}
          aria-label={mobileAccountOpen ? 'Close account menu' : 'Open account menu'}
          aria-expanded={mobileAccountOpen}
          aria-controls="mobile-account-links"
          onClick={() => {
            setMobileAccountOpen(!mobileAccountOpen)
            setMobileMenuOpen(false)
          }}
        >
          {initials ?? <ProfileGlyph />}
        </button>
        {(mobileMenuOpen || mobileAccountOpen) && <button className={s.mobileMenuBackdrop} aria-label="Close menu" onClick={closeMobilePanels} />}
        {mobileMenuOpen && (
          <nav id="mobile-navigation-menu" className={s.mobileMenuPanel} aria-label="Main menu">
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={path === link.href ? 'page' : undefined} onClick={closeMobilePanels}>
                <NavIcon path={link.icon} />
                <span>{link.label}</span>
              </Link>
            ))}
            <div className={s.mobileMenuDivider} />
            <Link href="/history" aria-current={path === '/history' ? 'page' : undefined} onClick={closeMobilePanels}>My entry</Link>
            <Link href="/grid" aria-current={path === '/grid' ? 'page' : undefined} onClick={closeMobilePanels}>Full pick grid</Link>
            <Link href="/standings#rules" onClick={closeMobilePanels}>Pool rules</Link>
          </nav>
        )}
        {mobileAccountOpen && <div className={s.mobileAccountPanel}>{accountLinks('mobile-account-links', closeMobilePanels)}</div>}
      </header>

      <nav className={s.mobileNav} aria-label="Mobile navigation">
        {links.map((link) => (
          <Link href={link.href} key={link.href} aria-current={path === link.href ? 'page' : undefined} onClick={closeMobilePanels}>
            <NavIcon path={link.icon} />
            {link.shortLabel}
          </Link>
        ))}
      </nav>
    </>
  )
}
