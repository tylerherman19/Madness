'use client'
import { useState } from 'react'
import s from '@/app/components/pp.module.css'

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
  return (
    <div className={s.authBody} style={{ maxWidth: 520 }}>
      <label className={s.checkRow}>
        <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
        <span>Email me pick reminders and elimination notices</span>
      </label>
      <p className={s.small} style={{ marginTop: 8 }}>Password resets are handled separately.</p>
      <button type="button" className={s.cta} disabled={busy} onClick={save}>Save preferences</button>
      <p role="status" className={s.small} style={{ marginTop: 8 }}>{message}</p>
    </div>
  )
}
