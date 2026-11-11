'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Game, Slate } from '@/types'
import type { ResultsAttention } from '@/lib/attention'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

interface Props {
  slate: Slate
  games: Game[]
  pendingEliminations: number
  attention?: ResultsAttention
}

type GameResult = 'home_win' | 'away_win' | 'tie' | 'pending'
type Action = 'set' | 'release' | 'void' | 'unvoid'

interface Panel { gameId: string; home: string; away: string; action: Action; result: GameResult }
interface Impact { home: { team: string; picks: number; alive: number }; away: { team: string; picks: number; alive: number } }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// What a confirmed action will do, in plain words, from the pick counts for the two teams.
function consequences(panel: Panel, impact: Impact): string[] {
  const { home, away } = impact
  const entries = (n: number) => plural(n, 'entry', 'entries')
  if (panel.action === 'void') {
    return [`${entries(home.picks + away.picks)} picked ${home.team} or ${away.team} (${home.alive + away.alive} alive). All of them survive this game.`,
      'The team stays used. Nobody gets a new pick or a longer deadline.',
      'The game stops blocking grading and advancing.']
  }
  if (panel.action === 'unvoid') {
    return [`${entries(home.picks + away.picks)} picked ${home.team} or ${away.team}. Their picks count again and the game goes back to pending.`]
  }
  if (panel.action === 'release') {
    return ['ESPN decides this result again at its next sync, and entries are re-graded then.']
  }
  if (panel.result === 'pending') {
    return ['Clears the result and hands the game back to ESPN.',
      `${entries(home.picks + away.picks)} picked ${home.team} or ${away.team}. Anyone eliminated only by this result is restored if no later day has locked.`]
  }
  const lost = panel.result === 'tie' ? [home, away] : panel.result === 'home_win' ? [away] : [home]
  const won = panel.result === 'tie' ? [] : panel.result === 'home_win' ? [home] : [away]
  const lines = lost.map((t) => `${entries(t.picks)} picked ${t.team} (${t.alive} alive) and will be eliminated${panel.result === 'tie' ? ' (a tie counts as a loss)' : ''}.`)
  for (const t of won) lines.push(`${entries(t.picks)} picked ${t.team} and survive this game (in a two-pick round every pick must win).`)
  lines.push('If this changes an earlier result, entries it had wrongly eliminated are restored while no later day has locked.')
  return lines
}

export default function ResultsForm({ slate, games, pendingEliminations, attention }: Props) {
  const router = useRouter()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [impact, setImpact] = useState<Impact | null>(null)
  const [reason, setReason] = useState('')
  const [applying, setApplying] = useState(false)
  const applyInFlight = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  // State updates are async, so a fast double-click could start two requests before `disabled` renders.
  const gradingInFlight = useRef(false)
  const [message, setMessage] = useState<StatusMessage | null>(null)
  const [gradingResult, setGradingResult] = useState<null | {
    eliminated: string[]
    advanced: string[]
    restored?: string[]
    needsManualRestore?: string[]
  }>(null)

  async function openPanel(next: Panel) {
    setPanel(next)
    setImpact(null)
    setReason('')
    setMessage(null)
    try {
      const res = await fetch(`/api/results/impact?game_id=${next.gameId}`)
      const data = await res.json()
      if (res.ok) setImpact(data.impact)
      else setMessage({ tone: 'error', text: `Error: ${data.error}` })
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    }
  }

  async function applyPanel() {
    if (!panel || applyInFlight.current || reason.trim().length < 3) return
    applyInFlight.current = true
    setApplying(true)
    setMessage(null)
    try {
      const res = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: panel.gameId, action: panel.action, result: panel.result, reason: reason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
        return
      }
      setMessage({ tone: 'ok', text: `Saved: ${panel.away} @ ${panel.home}.` })
      setPanel(null)
      if (data.grading) setGradingResult(data.grading)
      router.refresh()
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      applyInFlight.current = false
      setApplying(false)
    }
  }

  async function gradeAllPending() {
    if (gradingInFlight.current) return
    gradingInFlight.current = true
    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/results/grade-week', {
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
      gradingInFlight.current = false
      setSubmitting(false)
    }
  }

  const btn = 'px-3 py-1.5 rounded-lg border border-line-strong bg-surface text-sm font-medium text-ink hover:bg-sunken'
  const resultOptions: { value: GameResult; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'home_win', label: 'Home Win' },
    { value: 'away_win', label: 'Away Win' },
    { value: 'tie', label: 'Tie' },
  ]

  return (
    <div className="space-y-6">
      {attention && (attention.stalled.length > 0 || attention.restore.length > 0) && (
        <section aria-label="Needs attention" className="rounded-xl border border-warning bg-surface p-4 space-y-3">
          <h2 className="font-semibold text-ink">Needs attention ({attention.count})</h2>
          {attention.stalled.map((g) => (
            <div key={g.game_id} className="flex items-center justify-between gap-3 flex-wrap text-sm">
              <p className="text-ink">
                <span className="font-mono font-medium">{g.away_team} @ {g.home_team}</span> · Day {g.slate_number} · still pending {g.hours_late}h after tip ·{' '}
                {plural(g.home_picks, 'entry', 'entries')} picked {g.home_team}, {plural(g.away_picks, 'entry', 'entries')} picked {g.away_team}
              </p>
              <div className="flex gap-2">
                <button className={btn} onClick={() => openPanel({ gameId: g.game_id, home: g.home_team, away: g.away_team, action: 'set', result: 'home_win' })}>Enter result</button>
                <button className={btn} onClick={() => openPanel({ gameId: g.game_id, home: g.home_team, away: g.away_team, action: 'void', result: 'pending' })}>Void game</button>
              </div>
            </div>
          ))}
          {attention.restore.map((p) => (
            <p key={p.player_id} className="text-sm text-ink">
              {p.name} · eliminated on Day {p.slate_number} · wrongly eliminated by a corrected result: restore manually{' '}
              <Link className="underline" href="/admin/players">(Players)</Link>
            </p>
          ))}
        </section>
      )}

      <div className="space-y-3">
        {games.map((g) => {
          const voided = g.result === 'void'
          const manual = g.result_source === 'admin' && !voided
          const open = (action: Action, result: GameResult = g.result as GameResult) =>
            openPanel({ gameId: g.id, home: g.home_team, away: g.away_team, action, result })
          return (
            <div key={g.id} className="rounded-xl border border-line bg-surface p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-ink font-medium font-mono">
                  {g.away_team} @ {g.home_team}
                </p>
                <p className="text-muted text-xs mt-0.5">
                  {g.round_label ?? 'Regular season'}
                  {g.region && ` · ${g.region}`}
                  {g.tv && ` · ${g.tv}`}
                </p>
                {voided && <p className="text-warning text-xs mt-1">Voided: {g.result_note}</p>}
                {manual && <p className="text-warning text-xs mt-1">Manual result: {g.result_note}</p>}
              </div>
              <div className="flex gap-2 flex-wrap">
                {voided ? (
                  <button className={btn} onClick={() => open('unvoid')}>Undo void</button>
                ) : (
                  <>
                    {resultOptions.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => open('set', opt.value)}
                        aria-pressed={g.result === opt.value}
                        className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                          g.result === opt.value
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
                    {manual && <button className={btn} onClick={() => open('release')}>Release to ESPN</button>}
                    <button className={btn} onClick={() => open('void', 'pending')}>Void game</button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {panel && (
        <div role="dialog" aria-label="Confirm result change" className="rounded-xl border border-line-strong bg-surface p-4 space-y-3">
          <p className="font-semibold text-ink">
            {panel.action === 'set' ? 'Set result' : panel.action === 'release' ? 'Release to ESPN' : panel.action === 'void' ? 'Void game' : 'Undo void'}:{' '}
            <span className="font-mono">{panel.away} @ {panel.home}</span>
          </p>
          {panel.action === 'set' && (
            <label className="block text-sm text-ink">
              Result{' '}
              <select
                className="rounded-lg border border-line-strong bg-surface px-2 py-1"
                value={panel.result}
                onChange={(e) => setPanel({ ...panel, result: e.target.value as GameResult })}
              >
                {resultOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {impact ? (
            <ul className="text-sm text-ink list-disc pl-5 space-y-1" aria-label="Affected entries">
              {consequences(panel, impact).map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : (
            <p className="text-muted text-sm">Counting affected entries…</p>
          )}
          <label className="block text-sm text-ink">
            Reason (required)
            <input
              className="mt-1 block w-full rounded-lg border border-line-strong bg-surface px-3 py-2"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={applyPanel}
              disabled={applying || !impact || reason.trim().length < 3}
              aria-busy={applying}
              className="rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50"
            >
              {applying ? 'Saving…' : 'Confirm'}
            </button>
            <button onClick={() => setPanel(null)} disabled={applying} className={btn}>Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={gradeAllPending}
          disabled={submitting}
          aria-busy={submitting}
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
          {(gradingResult.restored?.length ?? 0) > 0 && (
            <div>
              <p className="text-success text-sm font-medium">Restored by the corrected result ({gradingResult.restored!.length}):</p>
              <p className="text-ink text-sm">{gradingResult.restored!.join(', ')}</p>
            </div>
          )}
          {(gradingResult.needsManualRestore?.length ?? 0) > 0 && (
            <div>
              <p className="text-warning text-sm font-medium">Wrongly eliminated by a corrected result: restore manually ({gradingResult.needsManualRestore!.length}):</p>
              <p className="text-ink text-sm">{gradingResult.needsManualRestore!.join(', ')}</p>
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
