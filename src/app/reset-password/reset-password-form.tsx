'use client'

import { useState, type FormEvent } from 'react'
import { apiRequest } from '@/lib/clientApi'

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
      const res = await apiRequest('/api/auth/reset-password', { method: 'POST', body: { token, password } })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setDone(true)
    } finally {
      setSaving(false)
    }
  }

  if (done) return <p className="text-sm font-bold" style={{ color: 'var(--green)' }}>Password updated. You can now log in.</p>

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="new-password" className="text-sm font-bold block mb-2">New password</label>
        <input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3.5 py-2.5 text-sm" />
      </div>
      <div>
        <label htmlFor="confirm-password" className="text-sm font-bold block mb-2">Confirm new password</label>
        <input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3.5 py-2.5 text-sm" />
      </div>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-full py-3">{saving ? 'Saving…' : 'Set new password'}</button>
    </form>
  )
}
