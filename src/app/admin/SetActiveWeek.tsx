'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from './statusTone'

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
  const [message, setMessage] = useState<StatusMessage | null>(null)

  const inactive = slates.filter((w) => !w.is_active)
  if (inactive.length === 0) return null

  async function handleActivate() {
    const slate = slates.find((w) => w.id === selected)
    if (!slate) return
    if (!confirm(`Make ${slate.slate_date} the active day? Players will immediately see it on the pick page.`)) return
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/set-active-slate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: selected }),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage({ tone: 'ok', text: `${slate.slate_date} is now active` })
        setSelected('')
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-warning/40 bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-warning">Set Active Day</p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
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
        <button
          onClick={handleActivate}
          disabled={!selected || loading}
          className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors"
        >
          {loading ? 'Activating…' : 'Activate'}
        </button>
      </div>
      {message && (
        <p role={TONE_ROLE[message.tone]} className={`text-xs ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}
    </div>
  )
}
