'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
export default function Actions({
  action,
  id,
}: {
  action: string
  id?: string
}) {
  const [reason, setReason] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState('record-only'),
    [allowlist, setAllowlist] = useState('')
  const router = useRouter()
  async function run() {
    setBusy(true)
    try {
      const response = await fetch('/api/admin/system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id, reason, mode, allowlist }),
      })
      const body = await response.json()
      setMessage(response.ok ? 'Recorded.' : body.error)
      if (response.ok) router.refresh()
    } catch {
      setMessage('Connection failed. Refresh to check the current state.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="system-actions">
      {action === 'mode' && (
        <>
          <label>
            Email mode{' '}
            <select
              aria-label="Email mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="record-only">Record only</option>
              <option value="test-recipients">Test recipients</option>
              <option value="live">
                Live (requires separate activation approval)
              </option>
            </select>
          </label>
          <label>
            Test recipients, comma separated{' '}
            <input
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
            />
          </label>
        </>
      )}
      <label>
        Explanation{' '}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </label>
      <button
        className="btn-secondary"
        disabled={busy || reason.trim().length < 3}
        onClick={run}
      >
        {busy
          ? 'Recording…'
          : action === 'mode'
            ? 'Save mode'
            : action === 'reconcile'
              ? 'Run integrity check'
              : action === 'retry-message'
                ? 'Retry safely'
                : 'Cancel remaining unsent messages'}
      </button>
      <p role="status">{message}</p>
    </div>
  )
}
