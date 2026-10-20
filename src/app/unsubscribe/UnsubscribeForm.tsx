'use client'

import { useState } from 'react'

export default function UnsubscribeForm({ p, t }: { p: string; t: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save(next: boolean) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p, t, enabled: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setError(data.error ?? 'Could not save. Try again.')
      else setEnabled(next)
    } catch {
      setError('Could not save. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p role="status" style={{ fontSize: 15 }}>
        {enabled === null ? 'Stop all pool emails to this address?' : enabled ? 'You are subscribed again.' : 'You are unsubscribed. You will get no more pool emails.'}
      </p>
      {error && <p role="alert" style={{ color: '#B42318', marginTop: 8 }}>{error}</p>}
      <button type="button" className="btn-primary w-full" style={{ marginTop: 16 }} disabled={busy} onClick={() => save(enabled === false)}>
        {busy ? 'Saving…' : enabled === false ? 'Resubscribe' : 'Unsubscribe'}
      </button>
    </div>
  )
}
