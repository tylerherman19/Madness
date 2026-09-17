'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import styles from './login.module.css'

export default function AdminLoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Login failed')
        return
      }

      router.push('/admin')
      router.refresh()
    } catch {
      setError('Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`${styles.page} admin-login-page min-h-screen flex items-center justify-center px-4`}>
      <div className={`${styles.card} admin-login-card w-full max-w-sm rounded-xl p-8`}>
        <div className={`${styles.brand} admin-login-brand`}>
          <svg viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M5 7h9v6h7v7h8v8h8" stroke="currentColor" strokeWidth="4"/><path d="M5 17h7v7H5m0 4h9v7H5" stroke="#4e84d8" strokeWidth="4"/></svg>
          <span>MADNESS<small>CONTROL ROOM</small></span>
        </div>
        <h1 className="font-display text-5xl mb-1">Admin access</h1>
        <p className="mb-7">Manage the pool, schedule, results, players, and messages.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="eyebrow block mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="field w-full px-3.5 py-2.5 text-sm"
            />
          </div>
          {error && <p className="text-sm rounded-md px-3 py-2" style={{ color: '#ff8a7a', background: 'rgba(192,57,43,0.18)' }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full font-display tracking-wider py-3"
          >
            {loading ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        <Link
          href="/standings"
          className="mt-6 inline-block text-sm font-bold"
          style={{ color: 'var(--muted)' }}
        >
          Back to standings
        </Link>
      </div>
    </div>
  )
}
