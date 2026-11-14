'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/admin/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null)
  return { ok: response.ok, error: data?.error as string | undefined, data }
}

export function ResolveIncident({ incidentKey, title }: { incidentKey: string; title: string }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run() {
    setBusy(true); setError('')
    try {
      const result = await post({ action: 'resolve-incident', id: incidentKey, reason: note })
      if (result.ok) router.refresh()
      else setError(result.error || 'That did not work. Try again.')
    } catch { setError('Could not reach the server. Try again.') }
    finally { setBusy(false) }
  }
  return (
    <div className="system-actions">
      <label>
        Note (what you did or decided){' '}
        <input aria-label={`Note for: ${title}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <button className="btn-secondary" disabled={busy || note.trim().length < 3} onClick={run} aria-label={`Mark as resolved: ${title}`}>
        {busy ? 'Saving…' : 'Mark as resolved'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

export function ClearRecovered({ count }: { count: number }) {
  const router = useRouter()
  const [note, setNote] = useState('Old problems that fixed themselves')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run() {
    setBusy(true); setMessage('')
    try {
      const result = await post({ action: 'clear-recovered', reason: note })
      if (result.ok) { setMessage(`Cleared ${result.data?.cleared ?? 0}.`); router.refresh() }
      else setMessage(result.error || 'That did not work. Try again.')
    } catch { setMessage('Could not reach the server. Try again.') }
    finally { setBusy(false) }
  }
  return (
    <div className="system-actions">
      <label>
        Note{' '}
        <input aria-label="Note for clearing recovered problems" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <button className="btn-secondary" disabled={busy || note.trim().length < 3 || count === 0} onClick={run}>
        {busy ? 'Clearing…' : 'Clear recovered problems'}
      </button>
      <p role="status">{message}</p>
    </div>
  )
}
