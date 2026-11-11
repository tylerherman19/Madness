'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
export default function StartTournament({ poolId, slates }: { poolId: string; slates: { id: string; slate_date: string }[] }) {
  const router = useRouter()
  const [day, setDay] = useState('')
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function start() {
    if (busy || confirmation !== 'START FRESH') return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/start-tournament', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pool_id: poolId, slate_id: day, reason, confirmation }) })
      const result = await res.json()
      setMessage(res.ok ? `Fresh March Madness contest opened. Previous entries and picks archived (${result.archive_id}).` : result.error)
      if (res.ok) { setConfirmation(''); router.refresh() }
    } catch { setMessage('Could not start the contest. Refresh to check its status before trying again.') }
    finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-line bg-surface p-5 space-y-4">
    <h2 className="font-semibold">Start a fresh March Madness contest</h2>
    <p className="text-sm text-muted">Archives the current contest, including entries, payments marked paid, picks, and results. Everyone registers again; previous eliminations and used teams do not carry over. The archive and switch complete together.</p>
    <label className="block text-sm">Tournament opening day<select className="field block w-full mt-1" value={day} onChange={e => setDay(e.target.value)} disabled={busy}>
      <option value="">Choose a synced tournament day</option>{slates.map(slate => <option key={slate.id} value={slate.id}>{slate.slate_date}</option>)}
    </select></label>
    {!slates.length && <p className="text-sm text-muted">Sync the future tournament opening day from Admin Schedule first.</p>}
    <label className="block text-sm">Reason<input className="field block w-full mt-1" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
    <label className="block text-sm">Type START FRESH to archive the current contest<input className="field block w-full mt-1" value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></label>
    <button className="btn-primary px-4 py-2" disabled={busy || !day || !reason.trim() || confirmation !== 'START FRESH'} onClick={start}>{busy ? 'Archiving…' : 'Archive and start March Madness'}</button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
