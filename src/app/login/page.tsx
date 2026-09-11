'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export default function LoginPage() {
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName.trim(), pin }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); return }
      router.push('/pick')
      router.refresh()
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell eyebrow="Player access" title="Log in" description="Enter your name and six-digit PIN to make or change your pick.">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="text-sm font-bold block mb-2" style={{ color: 'var(--dark)' }}>Full name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. John Smith"
                  required
                  autoComplete="name"
                  className="field w-full px-3.5 py-2.5 text-sm"
                  style={{ color: 'var(--dark)' }}
                />
              </div>
              <div>
                <label className="text-sm font-bold block mb-2" style={{ color: 'var(--dark)' }}>PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="6-digit PIN from your welcome email"
                  required
                  maxLength={6}
                  className="field w-full px-3.5 py-2.5 text-sm tnum tracking-widest"
                  style={{ color: 'var(--dark)' }}
                />
              </div>

              {error && (
                <p className="text-sm rounded-md px-3 py-2" style={{ color: 'var(--red)', background: 'var(--red-tint)' }}>{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-3"
              >
                {loading ? 'Logging in…' : 'Log in'}
              </button>
            </form>
          <div className="mt-6 space-y-3 text-center">
            <Link href="/forgot-pin" className="block text-sm font-bold underline" style={{ color: 'var(--muted)' }}>
              Forgot your PIN?
            </Link>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              New to the pool?{' '}
              <Link href="/signup" className="underline" style={{ color: 'var(--dark)' }}>Sign up here</Link>
            </p>
            <Link href="/" className="block text-sm font-bold" style={{ color: 'var(--muted)' }}>Back to the pool</Link>
          </div>
    </AuthShell>
  )
}
