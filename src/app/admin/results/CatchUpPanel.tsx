'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatSlateDate } from '@/lib/deadline'
import { TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

interface OpenDay {
  date: string
  number: number
}

interface CatchUpDay {
  date: string
  eliminated: string[]
  settled: boolean
  sync_error?: string
  error?: string
}

// Runs the nightly results job on demand: pull the latest results from ESPN
// and grade the active day plus any earlier day a failed run left open. The
// warning above the button lists those earlier days, since their losers are
// still marked alive until this runs.
export default function CatchUpPanel({ openDays, tracking }: { openDays: OpenDay[]; tracking: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)

  async function run() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/cron/sync-results', { method: 'POST' })
      const data = await res.json().catch(() => ({ error: `Results sync failed (HTTP ${res.status})` }))
      const caughtUp = (data.catch_up ?? []) as CatchUpDay[]
      const eliminated =
        (data.grading?.eliminated?.length ?? 0) +
        caughtUp.reduce((total, day) => total + day.eliminated.length, 0)
      const parts = [
        `${eliminated} eliminated`,
        caughtUp.length > 0 ? `${caughtUp.length} earlier day${caughtUp.length === 1 ? '' : 's'} graded` : null,
        data.deferred ? `${data.deferred} more on the next run` : null,
      ].filter(Boolean)
      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error ?? 'Results sync failed'} · ${parts.join(' · ')}` })
      } else {
        setMessage({ tone: 'ok', text: `${data.message ?? 'Results synced'} · ${parts.join(' · ')}` })
      }
      router.refresh()
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`rounded-xl border bg-slate-800 p-4 space-y-3 ${
        openDays.length > 0 ? 'border-amber-500/40' : 'border-slate-700'
      }`}
    >
      {openDays.length > 0 ? (
        <div>
          <p className="font-medium text-amber-400">
            {openDays.length === 1 ? 'An earlier game day still needs' : `${openDays.length} earlier game days still need`} grading
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {openDays.map((day) => formatSlateDate(day.date)).join(', ')} — anyone who lost on{' '}
            {openDays.length === 1 ? 'that day' : 'those days'} is still marked alive until this runs.
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          Pull the latest results from ESPN and grade every open game day — the same job that runs overnight.
        </p>
      )}
      {!tracking && (
        <p className="text-xs text-slate-500">
          Apply supabase/migrations/022_slate_grading_state.sql so days a missed run leaves ungraded are tracked
          and caught up automatically.
        </p>
      )}
      <button
        onClick={run}
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        {busy ? 'Syncing results…' : 'Sync results & grade now'}
      </button>
      {message && <p className={`text-sm ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>}
    </div>
  )
}
