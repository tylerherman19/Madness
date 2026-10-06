'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiRequest } from '@/lib/clientApi'

export default function AdminLogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    if (busy) return
    setBusy(true)
    const res = await apiRequest('/api/auth/admin', { method: 'DELETE' })
    if (!res.ok) {
      setBusy(false)
      alert(`Could not log out: ${res.error}`)
      return
    }
    router.replace('/admin/login')
    router.refresh()
  }

  return (
    <button
      onClick={handleLogout}
      disabled={busy}
      className="text-sm text-slate-400 hover:text-white transition-colors"
    >
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  )
}
