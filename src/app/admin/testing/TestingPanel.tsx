'use client'

import { useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { SandboxSnapshot, SandboxGame } from './page'

function formatCt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// Local-timezone value a <input type="datetime-local"> can round-trip.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function gameState(g: SandboxGame, effectiveNow: string): 'pre' | 'in' | 'final' {
  if (g.result !== 'pending') return 'final'
  return new Date(effectiveNow) >= new Date(g.tip_time) ? 'in' : 'pre'
}

export default function TestingPanel({
  testMode,
  snapshot,
  inviteToken,
}: {
  testMode: boolean
  snapshot: SandboxSnapshot
  inviteToken: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seedUsers, setSeedUsers] = useState(8)
  const [clockInput, setClockInput] = useState(() => toDatetimeLocal(snapshot.effectiveNow))
  const [scoreInputs, setScoreInputs] = useState<Record<string, { home: string; away: string }>>(() =>
    Object.fromEntries(
      snapshot.games.map((g) => [g.id, { home: g.home_score?.toString() ?? '', away: g.away_score?.toString() ?? '' }])
    )
  )

  async function callTestMode(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch('/api/admin/test-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Request failed')
        return null
      }
      return data
    } catch {
      setError('Network error')
      return null
    } finally {
      setBusy(null)
    }
  }

  async function runCron(label: string, path: string) {
    setBusy(path)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(path, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) setError(data.error || `${label} failed`)
      else setMessage(`${label}: ${JSON.stringify(data.results ?? data.grading ?? data.message ?? data)}`)
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
      router.refresh()
    }
  }

  // Origin is only known in the browser — null on the server snapshot avoids
  // a hydration mismatch.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => null
  )
  const inviteUrl =
    inviteToken && origin ? `${origin}/api/test-mode/join?token=${encodeURIComponent(inviteToken)}` : null

  return (
    <div className="space-y-6">
      {/* Toggle */}
      <div className="rounded-xl border border-line bg-surface p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-ink">
            Status:{' '}
            {testMode ? (
              <span className="text-warning">ENABLED — this browser is in the sandbox</span>
            ) : (
              <span className="text-muted">off — this browser sees production</span>
            )}
          </p>
          <p className="text-muted text-sm mt-1">
            Applies only to browsers holding the testing cookie. Closing the browser exits automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!testMode && (
            <button
              onClick={async () => {
                // One-click setup: enter the sandbox, then seed it. The enable
                // response sets the testing cookie, so the follow-up seed runs
                // against the sandbox.
                const enabled = await callTestMode('enable')
                if (!enabled) return
                const seeded = await callTestMode('seed', { users: seedUsers })
                if (seeded) {
                  setMessage(
                    `Sandbox ready: ${seeded.created_users} test users (password ${seeded.password}), Slate ${seeded.slate_number} with ${seeded.games} games.`
                  )
                }
                router.refresh()
              }}
              disabled={busy !== null}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-on-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Enter + Seed (quick start)'}
            </button>
          )}
          <button
            onClick={async () => {
              const data = await callTestMode(testMode ? 'disable' : 'enable')
              if (data) router.refresh()
            }}
            disabled={busy !== null}
            className={`rounded-lg px-5 py-2.5 text-sm font-bold text-on-accent transition-colors disabled:opacity-50 ${
              testMode ? 'bg-ink hover:bg-ink-2' : 'bg-warning hover:bg-warning/90'
            }`}
          >
            {busy === 'enable' || busy === 'disable'
              ? 'Working…'
              : testMode
              ? 'Exit Testing Mode'
              : 'Enter Testing Mode'}
          </button>
        </div>
      </div>

      {(message || error) && (
        <div
          className={`rounded-xl border p-4 text-sm break-all ${
            error ? 'border-danger/40 bg-danger-tint text-danger' : 'border-success/40 bg-success-tint text-success'
          }`}
        >
          {error || message}
        </div>
      )}

      {testMode && !snapshot.ok && (
        <div className="rounded-xl border border-danger/40 bg-danger-tint p-5 space-y-2">
          <p className="font-semibold text-danger">Sandbox database is not reachable</p>
          <p className="text-ink text-sm">{snapshot.error}</p>
          <p className="text-sm text-ink">
            One-time setup — run both files in the Supabase SQL editor:
          </p>
          <ol className="list-decimal pl-5 text-sm text-ink space-y-1">
            <li>Run <code className="text-warning">supabase/migrations/004_testing_sandbox.sql</code> (creates the sandbox tables).</li>
            <li>Run <code className="text-warning">supabase/migrations/007_sandbox_expose.sql</code> (exposes the schema to the API — no dashboard step needed).</li>
          </ol>
        </div>
      )}

      {testMode && snapshot.ok && (
        <>
          {/* Sandbox state */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Test Players" value={snapshot.players.length} />
            <Stat
              label="Active Slate"
              value={snapshot.activeSlate ? `Wk ${snapshot.activeSlate.slate_number}` : '—'}
            />
            <Stat label="Games" value={snapshot.gameCount} />
            <Stat label="Picks" value={snapshot.pickCount} />
          </div>

          {/* Seed / reset */}
          <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
            <p className="text-muted text-xs font-medium uppercase tracking-wide">Sandbox Data</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-ink">
                Test users:{' '}
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={seedUsers}
                  onChange={(e) => setSeedUsers(Number(e.target.value))}
                  className="w-16 rounded border border-line bg-sunken px-2 py-1 text-ink"
                />
              </label>
              <button
                onClick={async () => {
                  const data = await callTestMode('seed', { users: seedUsers })
                  if (data) {
                    setMessage(
                      `Seeded: ${data.created_users} new test users (password ${data.password}), Slate ${data.slate_number} with ${data.games} games.`
                    )
                    router.refresh()
                  }
                }}
                disabled={busy !== null}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
              >
                {busy === 'seed' ? 'Seeding…' : 'Seed Test Slate + Users'}
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Delete ALL sandbox data (players, slates, games, picks)? Production is untouched.')) return
                  const data = await callTestMode('reset')
                  if (data) {
                    setMessage('Sandbox wiped clean.')
                    router.refresh()
                  }
                }}
                disabled={busy !== null}
                className="rounded-lg border border-danger/40 bg-danger-tint px-4 py-2 text-sm font-semibold text-danger hover:bg-danger-tint transition-colors disabled:opacity-50"
              >
                {busy === 'reset' ? 'Resetting…' : 'Reset Sandbox'}
              </button>
            </div>
            <p className="text-muted text-sm">
              Seeding creates test users (login with their name + password <span className="font-mono text-ink">madness-test</span>)
              and one day of games anchored on tomorrow, tipping from 6:00 PM CT. The whole slate locks at that first tip.
              Prefer your own slate? Build it in{' '}
              <Link href="/admin/schedule" className="text-accent-strong underline">Schedule</Link> — while testing mode is
              on, every admin page edits the sandbox.
            </p>
          </div>

          {/* Sandbox clock */}
          <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-muted text-xs font-medium uppercase tracking-wide">Sandbox Clock</p>
              <p className="text-sm">
                {snapshot.simulatedNow ? (
                  <span className="text-warning font-semibold">{formatCt(snapshot.effectiveNow)} (simulated)</span>
                ) : (
                  <span className="text-muted">{formatCt(snapshot.effectiveNow)} (real time)</span>
                )}
              </p>
            </div>
            <p className="text-muted text-sm">
              Every deadline/lock check in the sandbox — pick locking, auto-assign, the sweat board — reads this
              clock instead of the real time, so you can progress through a slate at your own pace.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="datetime-local"
                value={clockInput}
                onChange={(e) => setClockInput(e.target.value)}
                className="rounded border border-line bg-sunken px-2 py-1.5 text-sm text-ink"
              />
              <button
                onClick={async () => {
                  const data = await callTestMode('set_clock', { iso: new Date(clockInput).toISOString() })
                  if (data) { setMessage(`Sandbox clock set to ${formatCt(data.simulated_now)}.`); router.refresh() }
                }}
                disabled={busy !== null}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
              >
                {busy === 'set_clock' ? 'Setting…' : 'Set'}
              </button>
              {[
                ['+1h', 1],
                ['+6h', 6],
                ['+1d', 24],
              ].map(([label, hours]) => (
                <button
                  key={label}
                  onClick={async () => {
                    const data = await callTestMode('advance_clock', { hours })
                    if (data) { setMessage(`Sandbox clock advanced to ${formatCt(data.simulated_now)}.`); setClockInput(toDatetimeLocal(data.simulated_now)); router.refresh() }
                  }}
                  disabled={busy !== null}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
              <button
                onClick={async () => {
                  const data = await callTestMode('jump_to_next_kickoff')
                  if (data) { setMessage(`Sandbox clock jumped to next tip-off: ${formatCt(data.simulated_now)}.`); setClockInput(toDatetimeLocal(data.simulated_now)); router.refresh() }
                }}
                disabled={busy !== null || !snapshot.activeSlate}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
              >
                Jump to next tip-off
              </button>
              <button
                onClick={async () => {
                  const data = await callTestMode('reset_clock')
                  if (data) { setMessage('Sandbox clock reset to real time.'); setClockInput(toDatetimeLocal(new Date().toISOString())); router.refresh() }
                }}
                disabled={busy !== null}
                className="rounded-lg border border-danger/40 bg-danger-tint px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger-tint transition-colors disabled:opacity-50"
              >
                Reset to real time
              </button>
            </div>
          </div>

          {/* Game scores */}
          {snapshot.activeSlate && snapshot.games.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
              <p className="text-muted text-xs font-medium uppercase tracking-wide">
                Slate {snapshot.activeSlate.slate_number} Scores
              </p>
              <p className="text-muted text-sm">
                A game is <span className="text-ink font-medium">not started</span> before its tip-off,{' '}
                <span className="text-warning font-medium">in progress</span> once the sandbox clock passes
                tip-off, and only becomes <span className="text-success font-medium">final</span> when you mark it
                — which grades every pick on that team and updates standings.
              </p>
              <div className="space-y-2">
                {snapshot.games.map((g) => {
                  const state = gameState(g, snapshot.effectiveNow)
                  const scores = scoreInputs[g.id] ?? { home: '', away: '' }
                  return (
                    <div key={g.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-sunken p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                          state === 'final'
                            ? 'bg-success-tint text-success'
                            : state === 'in'
                            ? 'bg-warning-tint text-warning'
                            : 'bg-surface text-muted'
                        }`}
                      >
                        {state === 'final' ? 'Final' : state === 'in' ? 'In Progress' : 'Not Started'}
                      </span>
                      <span className="text-sm font-semibold text-ink min-w-[110px]">{g.away_team} @ {g.home_team}</span>
                      <span className="text-xs text-muted min-w-[130px]">{formatCt(g.tip_time)}</span>
                      <input
                        type="number"
                        min={0}
                        placeholder={g.away_team}
                        value={scores.away}
                        onChange={(e) => setScoreInputs((s) => ({ ...s, [g.id]: { ...scores, away: e.target.value } }))}
                        disabled={state === 'final'}
                        className="w-16 rounded border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50"
                      />
                      <span className="text-muted">–</span>
                      <input
                        type="number"
                        min={0}
                        placeholder={g.home_team}
                        value={scores.home}
                        onChange={(e) => setScoreInputs((s) => ({ ...s, [g.id]: { ...scores, home: e.target.value } }))}
                        disabled={state === 'final'}
                        className="w-16 rounded border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50"
                      />
                      <button
                        onClick={async () => {
                          const data = await callTestMode('set_score', {
                            game_id: g.id,
                            home_score: Number(scores.home) || 0,
                            away_score: Number(scores.away) || 0,
                          })
                          if (data) { setMessage(`${g.away_team} @ ${g.home_team} updated.`); router.refresh() }
                        }}
                        disabled={busy !== null || state === 'final'}
                        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
                      >
                        {busy === 'set_score' ? 'Saving…' : 'Save Score'}
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Mark ${g.away_team} @ ${g.home_team} final and grade picks?`)) return
                          const data = await callTestMode('finalize_game', { game_id: g.id })
                          if (data) { setMessage(`Finalized ${g.away_team} @ ${g.home_team}: ${data.result}.`); router.refresh() }
                        }}
                        disabled={busy !== null || state === 'final' || scores.home === '' || scores.away === ''}
                        className="rounded-lg border border-success/40 bg-success-tint px-3 py-1.5 text-xs font-semibold text-success hover:bg-success-tint transition-colors disabled:opacity-50"
                      >
                        {busy === 'finalize_game' ? 'Finalizing…' : state === 'final' ? 'Final' : 'Mark Final'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Test users */}
          {snapshot.players.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-5">
              <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
                Test Users ({snapshot.players.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {snapshot.players.map((p) => (
                  <span
                    key={p.id}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${
                      p.status === 'alive'
                        ? 'border-success/40 bg-success-tint text-success'
                        : 'border-danger/40 bg-danger-tint text-danger line-through'
                    }`}
                  >
                    {p.full_name}
                  </span>
                ))}
              </div>
              <p className="text-muted text-sm mt-3">
                Add more via <Link href="/admin/players" className="text-accent-strong underline">Manage Players</Link> (CSV
                import), the public <Link href="/signup" className="text-accent-strong underline">signup form</Link>, or
                another seed run.
              </p>
            </div>
          )}

          {/* Simulate cron jobs */}
          <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
            <p className="text-muted text-xs font-medium uppercase tracking-wide">Simulate Scheduled Jobs</p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => runCron('Auto-assign', '/api/cron/auto-assign')}
                disabled={busy !== null}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
              >
                {busy === '/api/cron/auto-assign' ? 'Running…' : 'Run Auto-Assign'}
              </button>
              <button
                onClick={() => runCron('Result sync', '/api/cron/sync-results')}
                disabled={busy !== null}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-line transition-colors disabled:opacity-50"
              >
                {busy === '/api/cron/sync-results' ? 'Running…' : 'Run ESPN Result Sync'}
              </button>
            </div>
            <p className="text-muted text-sm">
              These hit the same endpoints Vercel Cron does, but run against the sandbox. Auto-assign only acts once
              the Sunday 12 PM CT deadline has passed on the <span className="text-warning">sandbox clock above</span>;
              result sync still only matches games that exist on the real ESPN scoreboard — for made-up matchups, use{' '}
              <span className="text-warning">Mark Final</span> in Slate Scores above instead of running it here.
            </p>
          </div>

          {/* Invite link */}
          {inviteUrl && (
            <div className="rounded-xl border border-line bg-surface p-5 space-y-2">
              <p className="text-muted text-xs font-medium uppercase tracking-wide">Invite a Tester</p>
              <p className="text-muted text-sm">
                Opening this link puts that device into the sandbox (no admin access). Valid for 7 days.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded bg-sunken px-3 py-2 text-xs text-warning">{inviteUrl}</code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl)
                    setMessage('Invite link copied.')
                  }}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink hover:bg-line transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>
          )}

          {/* Shortcuts */}
          <div className="rounded-xl border border-line bg-surface p-5">
            <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">Test the Full Flow</p>
            <div className="flex flex-wrap gap-3 text-sm">
              {(
                [
                  ['/', 'Standings'],
                  ['/login', 'Player Login'],
                  ['/pick', 'Submit Pick'],
                  ['/grid', 'Pick Grid'],
                  ['/live', 'Sweat Board'],
                  ['/admin/schedule', 'Schedule'],
                  ['/admin/results', 'Results'],
                  ['/admin/players', 'Players'],
                  ['/admin/recap', 'Recap'],
                ] as [string, string][]
              ).map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 font-semibold text-ink hover:bg-line transition-colors"
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-center">
      <p className="text-muted text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink">{value}</p>
    </div>
  )
}
