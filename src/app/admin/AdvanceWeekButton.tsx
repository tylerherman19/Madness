'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  currentSlateDate: string | null
}

// Advancing is date-driven now: there is no "slate N+1" to sync, because the
// next playing day might be tomorrow or five days out. /api/cron/auto-advance
// already walks the calendar forward to the next day with games, syncs it and
// activates it — so this button just runs that, rather than reimplementing it.
// The route refuses to advance while the active day still has games to tip.
export default function AdvanceSlateButton({ currentSlateDate }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  async function handleAdvance() {
    if (!confirm('Advance the pool to the next day with games? The schedule for that day is pulled from ESPN and set active.')) return
    setLoading(true)
    setMessage('')
    try {
      const res = await fetch('/api/cron/auto-advance')
      const data = await res.json()
      if (!res.ok) {
        setMessage(`Error: ${data.error}`)
        return
      }
      // The route answers ok:true with a message when it declines to advance
      // (games still to tip, nothing found ahead) — surface that verbatim
      // rather than claiming success.
      setMessage(
        data.advanced_to
          ? `✅ Advanced to ${data.advanced_to} — ${data.games_synced} games synced`
          : `ℹ️ ${data.message}`
      )
      router.refresh()
    } catch {
      setMessage('Server error. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-blue-700 bg-slate-800 p-4 space-y-3">
      <p className="text-sm font-semibold text-blue-300">Advance to Next Day</p>
      <p className="text-xs text-slate-400">
        {currentSlateDate
          ? `Currently on ${currentSlateDate}. Skips days with no games.`
          : 'No active day yet — load a schedule first.'}
      </p>
      <button
        onClick={handleAdvance}
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Advancing…' : 'Advance to next day'}
      </button>
      {message && (
        <p className={`text-xs ${message.startsWith('✅') ? 'text-green-400' : message.startsWith('ℹ️') ? 'text-slate-300' : 'text-red-400'}`}>{message}</p>
      )}
    </div>
  )
}
