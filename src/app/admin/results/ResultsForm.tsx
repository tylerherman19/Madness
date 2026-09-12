'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Game, Slate } from '@/types'
import { TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

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
            className="rounded-xl border border-slate-700 bg-slate-800 p-4 flex items-center justify-between gap-4 flex-wrap"
          >
            <div>
              <p className="text-white font-medium font-mono">
                {g.away_team} @ {g.home_team}
              </p>
              <p className="text-slate-400 text-xs mt-0.5">
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
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    results[g.id] === opt.value
                      ? opt.value === 'pending'
                        ? 'bg-slate-600 text-white'
                        : opt.value === 'tie'
                        ? 'bg-yellow-600 text-white'
                        : 'bg-green-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
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
          className="rounded-lg bg-green-600 px-6 py-2.5 font-semibold text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Grading…' : 'Grade All Picks & Eliminate Losers'}
        </button>
      </div>

      <p className="text-slate-400 text-sm">
        <span className="font-semibold text-white">Pending Grade:</span>{' '}
        {pendingEliminations} player{pendingEliminations === 1 ? '' : 's'} slated to be eliminated
      </p>

      {message && (
        <p className={`text-sm ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>
      )}

      {gradingResult && (
        <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 space-y-3">
          <p className="font-semibold text-white">Grading Result:</p>
          {gradingResult.eliminated.length > 0 && (
            <div>
              <p className="text-red-400 text-sm font-medium">Eliminated ({gradingResult.eliminated.length}):</p>
              <p className="text-slate-300 text-sm">{gradingResult.eliminated.join(', ')}</p>
            </div>
          )}
          {gradingResult.advanced.length > 0 && (
            <div>
              <p className="text-green-400 text-sm font-medium">Advanced ({gradingResult.advanced.length}):</p>
              <p className="text-slate-300 text-sm">{gradingResult.advanced.join(', ')}</p>
            </div>
          )}
          {gradingResult.eliminated.length === 0 && gradingResult.advanced.length === 0 && (
            <p className="text-slate-400 text-sm">No picks found for this slate yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
