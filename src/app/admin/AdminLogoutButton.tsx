'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminLogoutButton() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/admin', { method: 'DELETE' })
      if (!response.ok) { setError('Could not log out. Try again.'); return }
      router.push('/admin/login')
      router.refresh()
    } catch { setError('Could not log out. Check your connection.'); }
    finally { setBusy(false) }
  }

  return (
    <><button
      disabled={busy}
      onClick={handleLogout}
      className="text-sm text-muted hover:text-ink transition-colors"
    >
      Log out
    </button>{error && <span role="alert" className="text-xs">{error}</span>}</>
  )
}
