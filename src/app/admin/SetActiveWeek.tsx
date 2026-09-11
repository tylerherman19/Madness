'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface WeekOption {
  id: string
  slate_number: number
  season_year: number
  is_active: boolean
}

export default function SetActiveWeek({ slates }: { slates: WeekOption[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const inactive = slates.filter((w) => !w.is_active)
  if (inactive.length === 0) return null

  async function handleActivate() {
    const slate = slates.find((w) => w.id === selected)
    if (!slate) return
    if (!confirm(`Set Slate ${slate.slate_number} (${slate.season_year}) as the active slate? Players will immediately see it on the pick page.`)) return
    setLoading(true)
    setMessage('')
    try {
      const res = await fetch('/api/admin/set-active-slate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: selected }),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage(`✅ Slate ${data.slate_number} is now active`)
        setSelected('')
        router.refresh()
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage('Server error. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-red-900/60 bg-slate-800 p-4 space-y-3">
      <p className="text-sm font-semibold text-red-300">Set Active Slate</p>
      <p className="text-xs text-slate-400">
        Manually switch which slate is active. Use this to roll back or jump ahead — normally you should use Advance Season instead.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full sm:w-auto rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white"
        >
          <option value="">Select a slate…</option>
          {inactive.map((w) => (
            <option key={w.id} value={w.id}>
              Slate {w.slate_number} · {w.season_year}
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
        <p className={`text-xs ${message.startsWith('✅') ? 'text-green-400' : 'text-red-400'}`}>{message}</p>
      )}
    </div>
  )
}
