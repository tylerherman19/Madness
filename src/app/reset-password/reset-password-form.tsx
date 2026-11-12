'use client'

import Link from 'next/link'
import css from '@/app/components/pp.module.css'
import { useState, useSyncExternalStore, type FormEvent } from 'react'

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}
const hashToken = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''

export default function ResetPasswordForm({ token: queryToken }: { token?: string }) {
  // null while the server render cannot see the fragment yet.
  const fragmentToken = useSyncExternalStore(subscribeToHash, hashToken, () => null)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const token = queryToken || fragmentToken

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error || 'Could not reset password.')
        // A used, expired or invalid link is dead: take it out of the address bar and history.
        if (res.status === 400 && /link/i.test(data?.error ?? '')) window.history.replaceState(null, '', '/reset-password')
        return
      }
      // The link is spent; drop it from the address bar and history entry.
      window.history.replaceState(null, '', '/reset-password')
      setDone(true)
    } catch {
      setError('Could not reset password. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (token === null && !done) return null
  if (!token && !done) return <p className={css.authError}>This reset link isn’t valid. Ask the organizer for a new one.</p>

  if (done) return <div className="space-y-4"><p role="status">Password updated. Log in with your new password.</p><Link href="/login" className="btn-primary w-full py-3">Log in</Link></div>

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="new-password" className="block mb-2 font-semibold">New password</label>
        <input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3 py-2.5" />
      </div>
      <div>
        <label htmlFor="confirm-password" className="block mb-2 font-semibold">Confirm new password</label>
        <input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3 py-2.5" />
      </div>
      {error && <p role="alert" className={css.authError}>{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-full py-3">{saving ? 'Saving…' : 'Set new password'}</button>
    </form>
  )
}
