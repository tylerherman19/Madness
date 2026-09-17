import { getAdminSession } from '@/lib/session'
import { isTestMode } from '@/lib/testMode'
import AdminNav from './AdminNav'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const isAdmin = await getAdminSession()
  const testMode = await isTestMode()

  // Allow /admin/login without auth
  // (Next.js will still render the layout for /admin/login — handle in the page)
  // We check the path to avoid redirect loops

  return (
    <div className="admin-shell min-h-screen">
      {isAdmin && <AdminNav testMode={testMode} />}
      <div className={isAdmin ? 'admin-canvas' : 'admin-login-canvas'}>{children}</div>
    </div>
  )
}
