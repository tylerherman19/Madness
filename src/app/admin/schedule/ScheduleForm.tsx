'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Game, Slate } from '@/types'
import { TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

interface Props {
  slates: Slate[]
  activeSlate: Slate | null
  games: Game[]
  teams: string[]
}

interface NewGame {
  date: string
  time: string
  home_team: string
  away_team: string
}

const BLANK_GAME: NewGame = { date: '', time: '19:00', home_team: '', away_team: '' }

// The sync-espn-all route caps a single request at 45 days. A season is
// roughly five months, so the browser walks it in chunks and reports
// progress — one long request would hit the function timeout instead.
const CHUNK_DAYS = 20

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// A college season labelled 2027 runs November 2026 through early April 2027
// (the championship is the first Monday in April). Bounds are deliberately
// generous — days with no games cost one request and are skipped.
function seasonWindow(seasonYear: number): { start: string; end: string } {
  return { start: `${seasonYear - 1}-11-01`, end: `${seasonYear}-04-10` }
}

export default function ScheduleForm({ slates, activeSlate, games, teams }: Props) {
  const router = useRouter()
  const [seasonYear, setSeasonYear] = useState(activeSlate?.season_year ?? 2027)
  const [syncDate, setSyncDate] = useState(activeSlate?.slate_date ?? today())
  const [rangeStart, setRangeStart] = useState(seasonWindow(activeSlate?.season_year ?? 2027).start)
  const [rangeEnd, setRangeEnd] = useState(seasonWindow(activeSlate?.season_year ?? 2027).end)
  const [newGames, setNewGames] = useState<NewGame[]>([{ ...BLANK_GAME }])
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncingRange, setSyncingRange] = useState(false)
  const [progress, setProgress] = useState('')
  const [message, setMessage] = useState<StatusMessage | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function addGame() {
    setNewGames((prev) => [...prev, { ...BLANK_GAME }])
  }

  function removeGame(i: number) {
    setNewGames((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateGame(i: number, field: keyof NewGame, value: string) {
    setNewGames((prev) => prev.map((g, idx) => (idx === i ? { ...g, [field]: value } : g)))
  }

  async function syncOneDay() {
    setSyncing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/schedule/sync-espn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: syncDate, season_year: seasonYear }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
      } else {
        const partial = data.partial ? ` — ${data.partial.join(', ')} did not respond` : ''
        setMessage({
          tone: 'ok',
          text: `${syncDate}: ${data.games_synced} games, ${data.teams_seen} teams${partial}`,
        })
        router.refresh()
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      setSyncing(false)
    }
  }

  // Loads the whole season in one go. The work is identical to a date range —
  // it just fills the dates in for you.
  async function syncWholeSeason() {
    const { start, end } = seasonWindow(seasonYear)
    setRangeStart(start)
    setRangeEnd(end)
    await runRange(start, end, `the entire ${seasonYear} season`)
  }

  async function syncRange() {
    await runRange(rangeStart, rangeEnd, `${rangeStart} → ${rangeEnd}`)
  }

  async function runRange(start: string, end: string, label: string) {
    if (end < start) {
      setMessage({ tone: 'error', text: 'Error: end date is before start date' })
      return
    }
    const totalDays =
      Math.round(
        (new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) /
          86_400_000
      ) + 1
    if (!confirm(`Load ${label} from ESPN — ${totalDays} days? Keep this tab open; it takes a few minutes.`)) {
      return
    }

    setSyncingRange(true)
    setMessage(null)
    let games = 0
    let daysWithGames = 0
    let emptyDays = 0
    const failures: string[] = []

    try {
      let cursor = start
      let done = 0
      while (cursor <= end) {
        const chunkEnd = addDays(cursor, CHUNK_DAYS - 1) > end ? end : addDays(cursor, CHUNK_DAYS - 1)
        const pct = Math.min(100, Math.round((done / totalDays) * 100))
        setProgress(`${pct}% · ${cursor} → ${chunkEnd}`)

        const res = await fetch('/api/schedule/sync-espn-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ season_year: seasonYear, start_date: cursor, end_date: chunkEnd }),
        })
        const data = await res.json()
        if (!res.ok) {
          failures.push(`${cursor}: ${data.error}`)
        } else {
          games += data.total_games ?? 0
          daysWithGames += (data.days_synced ?? []).length
          emptyDays += (data.empty_days ?? []).length
          if (data.failures) failures.push(...data.failures.map((f: { date: string }) => f.date))
        }

        done += CHUNK_DAYS
        cursor = addDays(chunkEnd, 1)
      }

      const failNote = failures.length > 0 ? ` · ${failures.length} failed` : ''
      setMessage({
        tone: 'ok',
        text: `${daysWithGames} days loaded, ${games} games total · ${emptyDays} days with no games${failNote}`,
      })
      router.refresh()
    } catch {
      setMessage({
        tone: 'error',
        text: 'Server error partway through. Re-run — already-loaded days are skipped.',
      })
    } finally {
      setProgress('')
      setSyncingRange(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season_year: seasonYear, games: newGames }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'error', text: `Error: ${data.error}` })
      } else {
        setMessage({
          tone: 'ok',
          text: `Saved ${data.games_saved} game(s) across ${data.dates.length} day(s)`,
        })
        setNewGames([{ ...BLANK_GAME }])
        router.refresh()
      }
    } catch {
      setMessage({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteGame(gameId: string) {
    setDeletingId(gameId)
    try {
      const res = await fetch(`/api/schedule?id=${gameId}`, { method: 'DELETE' })
      if (res.ok) router.refresh()
      else setMessage({ tone: 'error', text: 'Failed to delete game' })
    } finally {
      setDeletingId(null)
    }
  }

  const busy = syncing || syncingRange

  return (
    <div className="space-y-8">
      {/* ESPN Auto-Sync — the normal way a slate gets built */}
      <div className="rounded-xl border border-green-700 bg-green-950/40 p-5 space-y-4">
        <div>
          <h2 className="text-base font-bold text-green-400 tracking-wide">Auto-Sync from ESPN</h2>
          <p className="text-xs text-slate-400 mt-1">
            Pulls one day at a time across the ACC, Big Ten, Big 12, SEC, Pac-12 and the NCAA
            tournament. Seeds, regions, round labels, venue and TV come with it.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Season</label>
            <input
              type="number"
              value={seasonYear}
              onChange={(e) => setSeasonYear(Number(e.target.value))}
              className="w-24 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white focus:border-green-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Day</label>
            <input
              type="date"
              value={syncDate}
              onChange={(e) => setSyncDate(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white focus:border-green-500 focus:outline-none"
            />
          </div>
          <button
            onClick={syncOneDay}
            disabled={busy}
            className="rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-2 text-sm font-bold text-white transition-colors"
          >
            {syncing ? 'Syncing…' : 'SYNC THIS DAY'}
          </button>
        </div>

        <div className="border-t border-green-900 pt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={syncWholeSeason}
              disabled={busy}
              className="rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-2 text-sm font-bold text-white transition-colors"
            >
              {syncingRange ? 'Loading…' : `SYNC ENTIRE ${seasonYear} SEASON`}
            </button>
            <span className="text-xs text-slate-400">
              November {seasonYear - 1} through the championship in April {seasonYear}.
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Roughly 160 days, loaded 20 at a time — keep the tab open, it takes a few minutes.
            Days with no games are skipped, not treated as errors, and re-running is safe:
            existing days are updated in place, never duplicated. Tip times ESPN hasn&rsquo;t
            announced yet come in as TBD and fill themselves in as the season approaches.
          </p>
          <p className="text-xs text-slate-500">Or pick your own window:</p>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-400 mb-1">From</label>
              <input
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white focus:border-green-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">To</label>
              <input
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white focus:border-green-500 focus:outline-none"
              />
            </div>
            <button
              onClick={syncRange}
              disabled={busy}
              className="rounded-lg border border-green-700 hover:bg-green-950 disabled:opacity-50 px-6 py-2 text-sm font-bold text-green-400 transition-colors"
            >
              {syncingRange ? 'Loading…' : 'LOAD DATE RANGE'}
            </button>
          </div>
          {progress && (
            <p className="text-xs text-green-400 tnum" aria-live="polite">
              Loading {progress}…
            </p>
          )}
        </div>

        {message && <p className={`text-sm ${TONE_TEXT_CLASS[message.tone]}`}>{message.text}</p>}
      </div>

      {/* Loaded days */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">
          Loaded Days <span className="text-slate-500 text-sm font-normal">({slates.length})</span>
        </h2>
        {slates.length === 0 ? (
          <p className="text-slate-400 text-sm">
            Nothing loaded yet. Use the date range above to pull the season in.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slates.map((s) => (
              <span
                key={s.id}
                className={`rounded-lg border px-2.5 py-1 text-xs font-mono ${
                  s.is_active
                    ? 'border-green-600 bg-green-950/60 text-green-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
                title={s.is_active ? 'Active slate' : undefined}
              >
                {s.slate_date}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Active slate's games */}
      {activeSlate && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-3">
            {activeSlate.slate_date} — Games
          </h2>
          {games.length === 0 ? (
            <p className="text-slate-400 text-sm">No games loaded for this day.</p>
          ) : (
            <div className="space-y-2">
              {games.map((g) => (
                <div
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-white font-medium font-mono">
                      {g.away_seed ? `(${g.away_seed}) ` : ''}
                      {g.away_team} @ {g.home_seed ? `(${g.home_seed}) ` : ''}
                      {g.home_team}
                    </span>
                    {g.round_label && (
                      <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                        {g.round_label}
                        {g.region ? ` · ${g.region}` : ''}
                      </span>
                    )}
                    {g.tv && <span className="text-slate-500 text-xs">{g.tv}</span>}
                    <span className="text-slate-500 text-xs">
                      {g.time_tbd
                        ? 'Tip time TBD'
                        : new Date(g.tip_time).toLocaleString('en-US', {
                            timeZone: 'America/Chicago',
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZoneName: 'short',
                          })}
                    </span>
                  </div>
                  <button
                    onClick={() => deleteGame(g.id)}
                    disabled={deletingId === g.id}
                    className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                  >
                    {deletingId === g.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual entry — the fallback when ESPN doesn't carry a game */}
      <form onSubmit={handleSubmit} className="space-y-5 border-t border-slate-800 pt-8">
        <div>
          <h2 className="text-lg font-semibold text-white">Add Games by Hand</h2>
          <p className="text-xs text-slate-400 mt-1">
            Only needed for a game ESPN doesn&rsquo;t list. Each game files itself under its own
            date — you don&rsquo;t pick a slate.
          </p>
        </div>

        <div className="space-y-4">
          {newGames.map((g, i) => (
            <div key={i} className="rounded-xl border border-slate-700 bg-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-300">Game {i + 1}</p>
                {newGames.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeGame(i)}
                    className="text-red-400 text-sm hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Away Team</label>
                  <input
                    list="team-list"
                    value={g.away_team}
                    onChange={(e) => updateGame(i, 'away_team', e.target.value.toUpperCase())}
                    required
                    placeholder="e.g. DUKE"
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Home Team</label>
                  <input
                    list="team-list"
                    value={g.home_team}
                    onChange={(e) => updateGame(i, 'home_team', e.target.value.toUpperCase())}
                    required
                    placeholder="e.g. UNC"
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Date (Central)</label>
                  <input
                    type="date"
                    value={g.date}
                    onChange={(e) => updateGame(i, 'date', e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Tip-off (Central)</label>
                  <input
                    type="time"
                    value={g.time}
                    onChange={(e) => updateGame(i, 'time', e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Teams already seen in the feed — a hint, not a restriction, since a
            manual game may involve a team that hasn't synced yet. */}
        <datalist id="team-list">
          {teams.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={addGame}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            + Add another
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-2 text-sm font-bold text-white"
          >
            {submitting ? 'Saving…' : 'SAVE GAMES'}
          </button>
        </div>
      </form>
    </div>
  )
}
