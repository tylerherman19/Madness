'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Game, Slate } from '@/types'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

interface Props {
  slate: Slate
  games: Game[]
  pendingEliminations: number
}

type GameResult = 'home_win' | 'away_win' | 'tie' | 'pending'

export default function ResultsForm({ slate, games, pendingEliminations }: Props) {
  const router = useRouter()
  const [results, setResults] = useState<Record<string, GameResult>>(
    Object.fromEntries(games.map((g) => [g.id, g.result as GameResult]))
  )
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)
  const [gradingResult, setGradingResult] = useState<null | {
    eliminated: string[]
    advanced: string[]
  }>(null)

  async function saveResult(gameId: string, result: GameResult) {
    setResults((prev) => ({ ...prev, [gameId]: result }))
    setMessage(null)

    try {
      const res = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: gameId, result }),
      })
      const data = await res.json()

      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
        return
      }

      if (data.grading) {
        setGradingResult(data.grading)
        router.refresh()
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    }
  }

  async function gradeAllPending() {
    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/results/grade-slate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: slate.id }),
      })
      const data = await res.json()
      if (res.ok && data.grading) {
        setGradingResult(data.grading)
        setMessage({
          tone: 'ok',
          text: `Graded ${slate.slate_number}. ${data.grading.eliminated.length} eliminated.`,
        })
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: data.error || 'Grading failed' })
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error' })
    } finally {
      setSubmitting(false)
    }
  }

  const resultOptions: { value: GameResult; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'home_win', label: 'Home Win' },
    { value: 'away_win', label: 'Away Win' },
    { value: 'tie', label: 'Tie' },
  ]

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {games.map((g) => (
          <div
            key={g.id}
            className="rounded-xl border border-line bg-surface p-4 flex items-center justify-between gap-4 flex-wrap"
          >
            <div>
              <p className="text-ink font-medium font-mono">
                {g.away_team} @ {g.home_team}
              </p>
              <p className="text-muted text-xs mt-0.5">
                {g.round_label ?? 'Regular season'}
                {g.region && ` · ${g.region}`}
                {g.tv && ` · ${g.tv}`}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {resultOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => saveResult(g.id, opt.value)}
                  aria-pressed={results[g.id] === opt.value}
                  className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                    results[g.id] === opt.value
                      ? opt.value === 'pending'
                        ? 'border-ink bg-ink text-on-accent'
                        : opt.value === 'tie'
                        ? 'border-warning bg-warning text-on-accent'
                        : 'border-success bg-success text-on-accent'
                      : 'border-line-strong bg-surface text-ink hover:bg-sunken'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={gradeAllPending}
          disabled={submitting}
          className="rounded-lg bg-accent px-6 py-2.5 font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Grading…' : 'Grade All Picks & Eliminate Losers'}
        </button>
      </div>

      <p className="text-muted text-sm">
        <span className="font-semibold text-ink">Pending Grade:</span>{' '}
        {pendingEliminations} player{pendingEliminations === 1 ? '' : 's'} slated to be eliminated
      </p>

      {message && (
        <p role={TONE_ROLE[message.tone]} className={`text-sm ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}

      {gradingResult && (
        <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <p className="font-semibold text-ink">Grading Result:</p>
          {gradingResult.eliminated.length > 0 && (
            <div>
              <p className="text-danger text-sm font-medium">Eliminated ({gradingResult.eliminated.length}):</p>
              <p className="text-ink text-sm">{gradingResult.eliminated.join(', ')}</p>
            </div>
          )}
          {gradingResult.advanced.length > 0 && (
            <div>
              <p className="text-success text-sm font-medium">Advanced ({gradingResult.advanced.length}):</p>
              <p className="text-ink text-sm">{gradingResult.advanced.join(', ')}</p>
            </div>
          )}
          {gradingResult.eliminated.length === 0 && gradingResult.advanced.length === 0 && (
            <p className="text-muted text-sm">No picks found for this slate yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
