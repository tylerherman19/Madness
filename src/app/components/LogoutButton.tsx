'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiRequest } from '@/lib/clientApi'

export default function LogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function handleLogout() {
    if (busy) return
    setBusy(true)
    const res = await apiRequest('/api/auth/logout', { method: 'POST' })
    if (!res.ok) {
      setBusy(false)
      alert(`Could not log out: ${res.error}`)
      return
    }
    // Replace (not push) so Back doesn't return to a page rendered while
    // logged in; refresh drops the router cache of private pages.
    router.replace('/')
    router.refresh()
  }
  return (
    <button onClick={handleLogout} disabled={busy} className="text-xs tracking-widest uppercase transition-colors" style={{ color: '#888' }}>
      {busy ? 'Logging out…' : 'Log Out'}
    </button>
  )
}
