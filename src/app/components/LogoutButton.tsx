'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { resetViewer } from './useViewer'

// Styled by where it sits (the header's nav and phone menu).
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
      resetViewer()
      router.push('/')
      router.refresh()
    } catch { setError('Could not log out. Check your connection.') }
    finally { setBusy(false) }
  }
  return (
    <>
      <button type="button" disabled={busy} onClick={handleLogout}>Log out</button>
      {error && <span role="alert">{error}</span>}
    </>
  )
}
