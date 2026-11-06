'use client'

import Link from 'next/link'
import css from '@/app/components/pp.module.css'
import { useState, type FormEvent } from 'react'

export default function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

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
        return
      }
      setDone(true)
    } catch {
      setError('Could not reset password. Try again.')
    } finally {
      setSaving(false)
    }
  }

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
