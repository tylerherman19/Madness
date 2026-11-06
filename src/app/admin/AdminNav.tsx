'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import AdminLogoutButton from './AdminLogoutButton'
import BrandMark from '@/app/components/BrandMark'

const GAME_LINKS: [string,string][]=[['/admin','Overview'],['/admin/players','Players'],['/admin/picks','Picks'],['/admin/results','Results'],['/admin/email','Communications'],['/admin/config','Rules'],['/admin/schedule','Schedule'],['/admin/history','History']]
const SYSTEM_LINKS: [string,string][]=[['/admin/system','Overview'],['/admin/system/email','Email operations'],['/admin/system/jobs','Background jobs'],['/admin/system/incidents','Errors and incidents'],['/admin/system/integrity','Data integrity'],['/admin/system/recovery','Recovery'],['/admin/audit','Audit history']]

export default function AdminNav({ testMode }: { testMode: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const path = usePathname()

  const system=path.startsWith('/admin/system')||path==='/admin/operations'||path==='/admin/audit'
  const LINKS=system?SYSTEM_LINKS:GAME_LINKS

  return (
    <nav className="admin-rail">
      <div className="admin-rail-inner">
        <Link href="/" className="admin-brand" aria-label="Pick and Pray, back to the pool">
          <BrandMark tone="light" />
          <span>Pick and Pray<small>Admin</small></span>
        </Link>
        <div className="workspace-switch" aria-label="Admin workspace"><Link href="/admin" aria-current={!system?'page':undefined}>Game</Link><Link href="/admin/system" aria-current={system?'page':undefined}>System</Link></div>

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
