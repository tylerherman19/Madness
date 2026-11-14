'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from './statusTone'

// The one control for a stale active day. Posts to the existing set-active-week route.
export default function JumpToCurrentDay({ activeDate }: { activeDate?: string }) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)
  const inFlight = useRef(false)

  async function jump() {
    if (inFlight.current || reason.trim().length < 3) return
    inFlight.current = true
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/set-active-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jump_to_current: true, reason: reason.trim(), override: confirm }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        setMessage({ tone: 'ok', text: `Done. The pool is now on ${data.to_date}. ${data.skipped_dates?.length ?? 0} missed day(s) were skipped.` })
        setReason(''); setNeedsConfirm(false); setConfirm(false)
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: data?.error || 'That did not work. Nothing was changed.' })
        if (data?.code === 'assignment-incomplete') setNeedsConfirm(true)
      }
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the server. Nothing was changed; try again.' })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink">
        This moves the pool to the first day whose pick deadline has not passed
        {activeDate ? ` (it is stuck on ${activeDate})` : ''}. Days that were missed are skipped: nobody is given an automatic pick for them and nobody is eliminated for not picking on them.
        Results that are already in are still graded.
      </p>
      <label className="block text-xs text-ink">
        Reason (required)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
      </label>
      {needsConfirm && (
        <label className="flex items-start gap-2 text-xs text-ink">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Skip that day anyway
        </label>
      )}
      <button
        onClick={jump}
        disabled={loading || reason.trim().length < 3 || (needsConfirm && !confirm)}
        className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors"
      >
        {loading ? 'Moving…' : 'Jump to the current day'}
      </button>
      {message && <p role={TONE_ROLE[message.tone]} className={`text-xs ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>}
    </div>
  )
}
