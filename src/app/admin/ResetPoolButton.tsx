'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from './statusTone'

const CONFIRM_PHRASE = 'RESET POOL'

export default function ResetPoolButton() {
  const router = useRouter()
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)

  async function handleReset() {
    if (typed !== CONFIRM_PHRASE) return
    if (!confirm('This permanently deletes every player, slate, game, and pick in production. There is no undo. Proceed?')) return
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/reset-pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed }),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage({ tone: 'ok', text: 'Pool reset to zero.' })
        setTyped('')
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
    <div className="rounded-xl border border-danger bg-danger-tint p-4 space-y-3">
      <p className="text-sm font-semibold text-danger">Reset Pool to Zero</p>
      <p className="text-xs text-ink">
        Permanently deletes every player, slate, game, and pick in production. Cannot be undone.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type "${CONFIRM_PHRASE}" to enable`}
          aria-label={`Type ${CONFIRM_PHRASE} to enable reset`}
          className="w-64 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-danger"
        />
        <button
          onClick={handleReset}
          disabled={typed !== CONFIRM_PHRASE || loading}
          className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-on-accent hover:bg-danger-strong disabled:opacity-40 transition-colors"
        >
          {loading ? 'Resetting…' : 'Reset Pool'}
        </button>
      </div>
      {message && (
        <p role={TONE_ROLE[message.tone]} className={`text-xs ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}
    </div>
  )
}
