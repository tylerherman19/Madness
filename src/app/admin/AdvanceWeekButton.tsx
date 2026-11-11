'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from './statusTone'
import SlatePreview, { type Preview } from './SlatePreview'

interface Props {
  currentSlateDate: string | null
}

// Advancing is date-driven now: there is no "slate N+1" to sync, because the
// next playing day might be tomorrow or five days out. /api/cron/auto-advance
// already walks the calendar forward to the next day with games, syncs it and
// activates it — so this button just runs that, rather than reimplementing it.
// The route refuses to advance while the active day still has games to tip.
// The admin first sees a preview and must give a reason, which is audited.
export default function AdvanceSlateButton({ currentSlateDate }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<StatusMessage | null>(null)

  async function handleReview() {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/slate-preview?action=advance')
      const data = await res.json()
      if (!res.ok) setMessage({ tone: 'error', text: `Error: ${data.error}` })
      else setPreview(data)
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  async function handleAdvance() {
    if (inFlight.current || reason.trim().length < 3) return
    inFlight.current = true
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/cron/auto-advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
        return
      }
      // The route answers ok:true with a message when it declines to advance
      // (games still to tip, nothing found ahead) — surface that verbatim
      // rather than claiming success.
      setMessage(
        data.advanced_to
          ? { tone: 'ok', text: `Advanced to ${data.advanced_to} — ${data.games_synced} games synced` }
          : { tone: 'info', text: data.message }
      )
      setPreview(null)
      setReason('')
      router.refresh()
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-accent bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-accent-strong">Advance to Next Day</p>
      <p className="text-xs text-muted">
        {currentSlateDate
          ? `Currently on ${currentSlateDate}`
          : 'No active day yet — load a schedule first.'}
      </p>
      {!preview ? (
        <button
          onClick={handleReview}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50 transition-colors"
        >
          {loading ? 'Checking…' : 'Review advance'}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">The next day with games is pulled from ESPN and set active. Players will see it on the pick page.</p>
          <SlatePreview preview={preview} toFallback="next day with games (found from the ESPN schedule)" />
          <label className="block text-xs text-ink">
            Reason (required)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <div className="flex gap-3">
            <button
              onClick={handleAdvance}
              disabled={loading || reason.trim().length < 3}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50 transition-colors"
            >
              {loading ? 'Advancing…' : 'Confirm advance'}
            </button>
            <button
              onClick={() => { setPreview(null); setReason('') }}
              disabled={loading}
              className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role={TONE_ROLE[message.tone]} className={`text-xs ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}
    </div>
  )
}
