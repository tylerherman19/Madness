'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface ArchivedContestSummary {
  pool_id: string
  name: string
  season_year: number
  starts_on: string | null
  ended_on: string | null
  players: number
  picks: number
  deletable: boolean
  blocked_reason: string | null
}

// Permanently removes one archived contest's entries and picks. Deliberately
// separate from, and styled unlike, "start a fresh contest": the organizer
// sees exactly what will go, then types the contest's name and a reason.
export default function DeleteArchivedContest({ contests }: { contests: ArchivedContestSummary[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const contest = contests.find((row) => row.pool_id === selected) ?? null

  async function remove() {
    if (busy || !contest || name !== contest.name || !reason.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/delete-contest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pool_id: contest.pool_id, confirm_name: name, reason }),
      })
      const result = await res.json()
      setMessage(res.ok ? result.result?.message ?? 'Done.' : result.error)
      if (res.ok) { setName(''); setReason(''); router.refresh() }
    } catch {
      setMessage('Could not reach the server. Refresh to check the contest before trying again.')
    } finally { setBusy(false) }
  }

  return <section className="rounded-xl border border-danger/40 bg-danger-tint p-5 space-y-4">
    <h2 className="font-semibold text-danger">Delete an archived contest</h2>
    <p className="text-sm text-ink">Permanently deletes one finished contest&apos;s entries and picks. The active contest can never be deleted here. A recovery snapshot is saved before anything is removed. Schedules and results are kept.</p>
    {contests.length === 0 ? <p className="text-sm text-muted">There are no archived contests.</p> : <>
      <label className="block text-sm">Archived contest<select className="field block w-full mt-1" value={selected} onChange={e => { setSelected(e.target.value); setName(''); setMessage('') }} disabled={busy}>
        <option value="">Choose an archived contest</option>
        {contests.map((row) => <option key={row.pool_id} value={row.pool_id}>{row.name} · {row.season_year}{row.ended_on ? ` · ended ${row.ended_on}` : ''}</option>)}
      </select></label>
      {contest && <div className="space-y-3">
        <p className="text-sm text-ink" role="status">
          <strong>{contest.name}</strong>: {contest.players} {contest.players === 1 ? 'entry' : 'entries'} and {contest.picks} {contest.picks === 1 ? 'pick' : 'picks'} will be permanently deleted.
        </p>
        {!contest.deletable ? <p className="text-sm text-muted">{contest.blocked_reason}</p> : <>
          <label className="block text-sm">Reason<input className="field block w-full mt-1" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
          <label className="block text-sm">Type the contest name <strong>{contest.name}</strong> to confirm<input className="field block w-full mt-1" value={name} onChange={e => setName(e.target.value)} disabled={busy} autoComplete="off" /></label>
          <button className="rounded-lg border border-danger px-4 py-2 text-sm font-semibold text-danger disabled:opacity-50" disabled={busy || name !== contest.name || !reason.trim()} onClick={remove}>
            {busy ? 'Deleting…' : `Permanently delete ${contest.players} entries and ${contest.picks} picks`}
          </button>
        </>}
      </div>}
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
