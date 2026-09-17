'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import AdminLogoutButton from './AdminLogoutButton'

const LINKS: [string, string][] = [
  ['/admin', 'Dashboard'],
  ['/admin/config', 'Pool Config'],
  ['/admin/schedule', 'Schedule'],
  ['/admin/results', 'Results'],
  ['/admin/players', 'Players'],
  ['/admin/recap', 'Recap'],
  ['/admin/history', 'History'],
  ['/admin/audit', 'Audit'],
  ['/admin/email', 'Email'],
]

export default function AdminNav({ testMode }: { testMode: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const path = usePathname()

  return (
    <nav className="admin-rail">
      <div className="admin-rail-inner">
        <Link href="/" className="admin-brand" aria-label="Return to Madness">
          <svg viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M5 7h9v6h7v7h8v8h8" stroke="currentColor" strokeWidth="4"/><path d="M5 17h7v7H5m0 4h9v7H5" stroke="#4e84d8" strokeWidth="4"/></svg>
          <span>MADNESS<small>CONTROL ROOM</small></span>
        </Link>
        <span className="admin-mode">Pool operations</span>

        <div className="admin-desktop-links">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>
              {label}
            </Link>
          ))}
          <Link href="/admin/testing" aria-current={path === '/admin/testing' ? 'page' : undefined} className={testMode ? 'is-testing' : ''}>
            Testing{testMode ? ' ●' : ''}
          </Link>
        </div>
        <div className="admin-logout">
          <AdminLogoutButton />
        </div>

        <button
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Open admin menu"
          aria-expanded={menuOpen}
          className="admin-menu-button"
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {menuOpen && (
        <div className="admin-mobile-menu">
          <div>
            {LINKS.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={path === href ? 'page' : undefined}
                onClick={() => setMenuOpen(false)}
              >
                {label}
              </Link>
            ))}
            <Link
              href="/admin/testing"
              aria-current={path === '/admin/testing' ? 'page' : undefined}
              className={testMode ? 'is-testing' : ''}
              onClick={() => setMenuOpen(false)}
            >
              Testing{testMode ? ' ●' : ''}
            </Link>
            <div className="admin-mobile-logout">
              <AdminLogoutButton />
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
