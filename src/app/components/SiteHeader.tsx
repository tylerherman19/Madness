'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Wordmark from './Wordmark'
import { type CompetitionMode } from '@/lib/competition'

const BASE_NAV_LINKS = [
  { label: 'Pool', href: '/' },
  { label: 'Pick Grid', href: '/grid' },
  { label: 'Schedule', href: '/schedule' },
  { label: 'Live', href: '/live' },
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
}: {
  signupsClosed?: boolean
  mode?: CompetitionMode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = usePathname()
  // Sign Up only makes sense until the first pick period locks — signups
  // close for good then (enforced server-side too, this just matches).
  const showSignUp = !signupsClosed

  return (
    <header className="site-header">
      <div className="content-width site-header-inner">
        <Wordmark mode={mode} size={38} tone="dark" />

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Main navigation">
          {BASE_NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`nav-link ${pathname === link.href ? 'nav-link-active' : ''}`}
            >
              {link.label}
            </Link>
          ))}
          <Link href="/login" className={`nav-link ${pathname === '/login' ? 'nav-link-active' : ''}`}>Log in</Link>
          {showSignUp && <Link href="/signup" className="nav-link">Join pool</Link>}
          <RedButton href="/pick">Make a pick</RedButton>
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
            <Link href="/login" className="py-3 text-sm font-bold text-[var(--muted)]" onClick={() => setMenuOpen(false)}>Log in</Link>
          </div>
        </nav>
      )}
    </header>
  )
}
