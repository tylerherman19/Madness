'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { safeNext } from '@/lib/safeNext'
import { resetViewer } from '@/app/components/useViewer'
import s from '@/app/components/pp.module.css'

export default function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); return }
      resetViewer()
      // Read here rather than with useSearchParams, so the page stays built
      // ahead for everyone.
      router.push(safeNext(new URLSearchParams(window.location.search).get('next')))
      router.refresh()
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" aria-busy={loading} aria-describedby={error ? 'login-error' : undefined}>
      <div>
        <label htmlFor="login-email" className="block mb-2 font-semibold">Email</label>
        <input
          id="login-email" name="email" maxLength={254} type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoComplete="username"
          className="field w-full px-3 py-2.5"
        />
      </div>
      <div>
        <label htmlFor="login-password" className="block mb-2 font-semibold">Password</label>
        <input
          id="login-password" name="password" type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={72}
          autoComplete="current-password"
          className="field w-full px-3 py-2.5"
        />
      </div>
      {error && <p id="login-error" role="alert" className={s.authError}>{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full py-3">
        {loading ? 'Logging in…' : 'Log in'}
      </button>
    </form>
  )
}
