'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Wordmark from './Wordmark'
import LogoutButton from './LogoutButton'
import { type CompetitionMode } from '@/lib/competition'

const BASE_NAV_LINKS = [
  { label: 'Game center', href: '/' },
  { label: 'Pick Grid', href: '/grid' },
  { label: 'Schedule', href: '/schedule' },
  { label: 'Live', href: '/live' },
  { label: 'My picks', href: '/history' },
]

function RedButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="btn-primary px-4"
    >
      {children}
    </Link>
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
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = usePathname()
  // Sign Up only makes sense until the first pick period locks — signups
  // close for good then (enforced server-side too, this just matches).
  const showSignUp = !signupsClosed && !account

  return (
    <header className="site-header app-navigation">
      <div className="content-width site-header-inner">
        <Wordmark mode={mode} size={38} tone="dark" />

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Main navigation">
          <span className="navigation-label">Your courtside view</span>
          {BASE_NAV_LINKS.map((link, index) => (
            <Link
              key={link.href}
              href={link.href}
              className={`nav-link ${pathname === link.href ? 'nav-link-active' : ''}`}
              aria-current={pathname === link.href ? 'page' : undefined}
            >
              <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z','M4 4h16v16H4z M4 10h16 M10 4v16','M5 5h14v16H5z M8 2v6 M16 2v6 M5 11h14','M3 12h4l3-7 4 14 3-7h4','M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4'][index]}/></svg>
              {link.label}
            </Link>
          ))}
          <div className="navigation-divider"/>
          {account ? <div className="nav-link flex-wrap"><span>{account}</span><LogoutButton/></div> : <Link href="/login" className={`nav-link ${pathname === '/login' ? 'nav-link-active' : ''}`}>Log in</Link>}
          {showSignUp && <Link href="/signup" className="nav-link">Join pool</Link>}
          <RedButton href="/pick">Make a pick</RedButton>
          <div className="navigation-footnote"><strong>The last one standing.</strong><span>College basketball survivor</span><Link href="/#rules">How to play</Link></div>
        </nav>

        {/* Mobile: SUBMIT PICK button + hamburger */}
        <div className="md:hidden flex items-center gap-2">
          <RedButton href="/pick">Make a pick</RedButton>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="flex h-11 w-11 flex-col items-center justify-center gap-1.5 rounded-sm"
          >
            <span className="w-5 h-0.5 bg-gray-600"></span>
            <span className="w-5 h-0.5 bg-gray-600"></span>
            <span className="w-5 h-0.5 bg-gray-600"></span>
          </button>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {menuOpen && (
        <nav className="md:hidden border-t border-[var(--line)]" aria-label="Mobile navigation">
          <div className="content-width py-2 flex flex-col">
            {BASE_NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="py-3 text-sm font-bold text-[var(--muted)] hover:text-[var(--ink)]"
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {showSignUp && (
              <Link
                href="/signup"
                className="py-3 text-sm font-bold"
                style={{ color: 'var(--orange)' }}
                onClick={() => setMenuOpen(false)}
              >
                Sign Up
              </Link>
            )}
            {account ? <div className="flex justify-between items-center py-3"><span className="text-sm">{account}</span><LogoutButton/></div> : <Link href="/login" className="py-3 text-sm font-bold text-[var(--muted)]" onClick={() => setMenuOpen(false)}>Log in</Link>}
          </div>
        </nav>
      )}
    </header>
  )
}
