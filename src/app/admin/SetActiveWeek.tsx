'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from './statusTone'
import SlatePreview, { type Preview } from './SlatePreview'

interface SlateOption {
  id: string
  slate_number: number
  slate_date: string
  season_year: number
  is_active: boolean
}

export default function SetActiveSlate({ slates }: { slates: SlateOption[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reason, setReason] = useState('')
  const [override, setOverride] = useState(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)

  const inactive = slates.filter((w) => !w.is_active)
  if (inactive.length === 0) return null

  async function handleReview() {
    if (inFlight.current || !selected) return
    inFlight.current = true
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/slate-preview?action=activate&slate_id=${encodeURIComponent(selected)}`)
      const data = await res.json()
      if (!res.ok) setMessage({ tone: 'error', text: `Error: ${data.error}` })
      else { setPreview(data); setOverride(false) }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  async function handleActivate() {
    const slate = slates.find((w) => w.id === selected)
    if (!slate || inFlight.current || reason.trim().length < 3) return
    inFlight.current = true
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/set-active-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: selected, reason: reason.trim(), override }),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage({ tone: 'ok', text: `${slate.slate_date} is now active` })
        setSelected('')
        setPreview(null)
        setReason('')
        setOverride(false)
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
        if (data.code === 'assignment-incomplete') setPreview((p) => (p ? { ...p, blocked: true, message: data.error } : p))
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  function cancel() {
    setPreview(null)
    setReason('')
    setOverride(false)
  }

  return (
    <div className="rounded-xl border border-warning/40 bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-warning">Set Active Day</p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => { setSelected(e.target.value); cancel() }}
          disabled={loading || Boolean(preview)}
          aria-label="Day to activate"
          className="w-full sm:w-auto rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          <option value="">Select a day…</option>
          {inactive.map((w) => (
            <option key={w.id} value={w.id}>
              {w.slate_date}
            </option>
          ))}
        </select>
        {!preview && (
          <button
            onClick={handleReview}
            disabled={!selected || loading}
            className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors"
          >
            {loading ? 'Checking…' : 'Review change'}
          </button>
        )}
      </div>
      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted">Players will immediately see the new day on the pick page.</p>
          <SlatePreview preview={preview} toFallback="selected day" />
          {preview.blocked && (
            <div role="alert" className="text-xs text-danger space-y-2">
              <p>{preview.message}</p>
              <label className="flex items-center gap-2 text-ink">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                Change anyway (recorded as an override)
              </label>
            </div>
          )}
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
              onClick={handleActivate}
              disabled={loading || reason.trim().length < 3 || (preview.blocked && !override)}
              className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors"
            >
              {loading ? 'Activating…' : override ? 'Change anyway' : 'Confirm change'}
            </button>
            <button
              onClick={cancel}
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
