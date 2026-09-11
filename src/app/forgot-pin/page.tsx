'use client'

import { useState } from 'react'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export default function ForgotPinPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/forgot-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Something went wrong. Try again.'); return }
      setSent(true)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell eyebrow="Account recovery" title="Get a new PIN" description="Enter your email. If it matches an entry, we will send a new six-digit PIN.">
          {sent ? (
            <div className="border p-6 text-center" style={{ borderColor: 'var(--border)' }}>
              <p className="font-bold" style={{ color: 'var(--dark)' }}>Check your email</p>
              <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
                If that email is in our system, a new PIN is on its way.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-bold mb-2" style={{ color: 'var(--dark)' }}>Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="field w-full px-3.5 py-2.5 text-sm"
                  style={{ borderColor: 'var(--border)', color: 'var(--dark)' }}
                />
              </div>
              {error && <p className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-3"
              >
                {loading ? 'Sending…' : 'Send new PIN'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm font-bold underline" style={{ color: 'var(--muted)' }}>Back to log in</Link>
          </div>
    </AuthShell>
  )
}
