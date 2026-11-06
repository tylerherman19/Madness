import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'Admin', description: 'Pick and Pray pool administration.', robots: { index: false, follow: false } }
import { getAdminSession } from '@/lib/session'
import { getPoolConfig } from '@/lib/pool'
import { themeStyle } from '@/lib/poolTheme'
import { isTestMode } from '@/lib/testMode'
import AdminNav from './AdminNav'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const isAdmin = await getAdminSession()
  const testMode = await isTestMode()
  // The season's accent, the same as the pool pages.
  const pool = await getPoolConfig()

  // Allow /admin/login without auth
  // (Next.js will still render the layout for /admin/login — handle in the page)
  // We check the path to avoid redirect loops

  return (
    <div className="admin-shell min-h-screen" style={themeStyle(pool.competition_mode)}>
      {isAdmin && <AdminNav testMode={testMode} />}
      <main id="main" className={isAdmin ? 'admin-canvas' : 'admin-login-canvas'}>{children}</main>
    </div>
  )
}
