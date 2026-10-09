'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LogoutButton() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function handleLogout() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) { setError('Could not log out. Try again.'); return }
      router.push('/')
      router.refresh()
    } catch { setError('Could not log out. Check your connection.'); }
    finally { setBusy(false) }
  }
  return (
    <><button disabled={busy} onClick={handleLogout} className="text-xs tracking-widest uppercase transition-colors" style={{ color: 'var(--muted)' }}>
      Log Out
    </button>{error && <span role="alert" className="text-xs">{error}</span>}</>
  )
}
