'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_TEXT_CLASS, type StatusMessage } from './statusTone'
import { apiRequest } from '@/lib/clientApi'

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
      const res = await apiRequest('/api/admin/set-active-week', { method: 'POST', body: { slate_id: selected } })
      if (res.ok) {
        setMessage({ tone: 'ok', text: `${slate.slate_date} is now active` })
        setSelected('')
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: `Error: ${res.error}` })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-red-900/60 bg-slate-800 p-4 space-y-3">
      <p className="text-sm font-semibold text-red-300">Set Active Day</p>
      <p className="text-xs text-slate-400">
        Manually switch which day is active. Use this to roll back or jump ahead — normally Advance to Next Day is the one you want.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full sm:w-auto rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white"
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
          className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Activating…' : 'Activate'}
        </button>
      </div>
      {message && (
        <p className={`text-xs ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}
    </div>
  )
}
