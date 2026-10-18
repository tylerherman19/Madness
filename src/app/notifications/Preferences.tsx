 'use client'
import { useState } from 'react'
export default function Preferences({ enabled }: { enabled: boolean }) {
  const [checked, setChecked] = useState(enabled)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function save() {
    setBusy(true)
    try {
      const response = await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: checked }) })
      setMessage(response.ok ? 'Saved.' : 'Could not save. Please try again.')
    } catch { setMessage('Could not save. Please try again.') } finally { setBusy(false) }
  }
  return <div><label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> Email me pick reminders and elimination notices</label><p>Password resets are handled separately.</p><button className="btn-primary" disabled={busy} onClick={save}>Save preferences</button><p role="status">{message}</p></div>
}
