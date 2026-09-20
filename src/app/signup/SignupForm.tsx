'use client'

import { useState } from 'react'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export default function SignupForm() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [venmo, setVenmo] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName.trim(), email: email.trim(), phone: phone.trim() || undefined, venmo: venmo.trim() || undefined, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Signup failed'); return }
      setDone(true)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell eyebrow="Open registration" title="Join the pool" description="$25 entry. Pick winners, stay alive, and never use the same team twice.">
          {done ? (
            <div className="card p-6 sm:p-8 text-center space-y-4">
              <p className="font-display text-5xl" style={{ color: 'var(--green)' }}>You&apos;re in</p>
              <p className="text-sm" style={{ color: 'var(--dark)' }}>
                Your account is ready. Use the password you just chose to log in and submit picks.
              </p>
              <p className="text-sm rounded-md px-3 py-2" style={{ color: 'var(--dark)', background: 'var(--green-tint)' }}>
                Venmo <strong>@griffinsell</strong> $25 to lock in your spot.
              </p>
              <Link href="/login" className="btn-primary inline-flex px-6 py-3 mt-1">
                Log in
              </Link>
            </div>
          ) : (
            <>
              <div>
                <form onSubmit={handleSubmit} className="space-y-4">
                  {[
                    { label: 'Full Name', type: 'text', val: fullName, set: setFullName, placeholder: 'e.g. John Smith', required: true, autoComplete: 'name' },
                    { label: 'Email', type: 'email', val: email, set: setEmail, placeholder: 'you@example.com', required: true, autoComplete: 'email' },
                    { label: 'Phone', type: 'tel', val: phone, set: setPhone, placeholder: '(608) 555-1234', required: true, autoComplete: 'tel' },
                    { label: 'Venmo Handle', type: 'text', val: venmo, set: setVenmo, placeholder: '@yourhandle', required: true },
                  ].map(({ label, type, val, set, placeholder, required, autoComplete }) => (
                    <div key={label}>
                      <label className="text-sm font-bold block mb-2" style={{ color: 'var(--dark)' }}>{label}</label>
                      <input
                        type={type}
                        value={val}
                        onChange={(e) => set(e.target.value)}
                        placeholder={placeholder}
                        required={required}
                        autoComplete={autoComplete}
                        className="field w-full px-3.5 py-2.5 text-sm"
                        style={{ color: 'var(--dark)' }}
                      />
                    </div>
                  ))}

                  <div>
                    <label className="text-sm font-bold block mb-2" style={{ color: 'var(--dark)' }}>Create password</label>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3.5 py-2.5 text-sm" style={{ color: 'var(--dark)' }} />
                  </div>
                  <div>
                    <label className="text-sm font-bold block mb-2" style={{ color: 'var(--dark)' }}>Confirm password</label>
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Type it again" required minLength={8} maxLength={72} autoComplete="new-password" className="field w-full px-3.5 py-2.5 text-sm" style={{ color: 'var(--dark)' }} />
                  </div>

                  {error && <p className="text-sm rounded-md px-3 py-2" style={{ color: 'var(--red)', background: 'var(--red-tint)' }}>{error}</p>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary w-full py-3"
                  >
                    {loading ? 'Joining…' : 'Create my account'}
                  </button>
                </form>
              </div>

              <div className="mt-6 text-center space-y-2.5">
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Already have an account?{' '}
                  <Link href="/login" className="underline" style={{ color: 'var(--dark)' }}>Log in</Link>
                </p>
                <Link href="/" className="block text-sm font-bold" style={{ color: 'var(--muted)' }}>Back to the pool</Link>
              </div>
            </>
          )}
    </AuthShell>
  )
}
