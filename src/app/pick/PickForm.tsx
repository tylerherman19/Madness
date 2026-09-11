'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { teamColor } from '@/lib/teamColors'
import { capabilitiesFor, roundDisplay, type CompetitionMode } from '@/lib/competition'

export interface GameSide {
  team: string
  used: boolean
  /** "JAN 18" — when this team was spent. Null if it's still available. */
  usedOn: string | null
  /** Tournament seed. Null outside the bracket. */
  seed: number | null
  /** AP poll position. Null inside the bracket, where seed replaces it. */
  rank: number | null
  record: string | null
}

export interface GameRow {
  gameId: string
  kickoff: string // ISO UTC
  timeTbd: boolean
  round: string | null
  region: string | null
  venue: string | null
  tv: string | null
  away: GameSide
  home: GameSide
  deadline: string // ISO UTC
  locked: boolean
}

interface CurrentPick { team: string; deadline: string | null }
interface Props {
  slateId: string
  periodLabel: string
  pickHeading: string
  mode: CompetitionMode
  gameRows: GameRow[]
  usedTeams: string[]
  currentPick?: CurrentPick | null
}

const CT = 'America/Chicago'

function formatLockTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: CT, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

// "11:00 AM CT" — the heading games are grouped under. College basketball runs
// from late morning to late night, so the tip window is the thing that
// actually organises a day's board.
function formatTipSlot(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' }) + ' CT'
}

type Filter = 'all' | 'available' | 'ranked' | 'used'

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All Games',
  available: 'Available Teams',
  ranked: 'Top 25',
  used: 'Picked Teams',
}

// A seed or poll number, rendered the way a scoreboard renders it: small,
// ahead of the name, no decorative badge. Seeds matter in March; they should
// not shout.
function SeedMark({ seed, rank }: { seed: number | null; rank: number | null }) {
  const value = seed ?? rank
  if (value == null) return null
  return (
    <span
      className="tnum shrink-0"
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--muted)',
        minWidth: 14,
        textAlign: 'right',
      }}
      title={seed != null ? `${seed} seed` : `AP #${rank}`}
    >
      {seed != null ? seed : `#${rank}`}
    </span>
  )
}

function TeamHalf({
  side,
  disabled,
  selected,
  isCurrentPick,
  onClick,
}: {
  side: GameSide
  disabled: boolean
  selected: boolean
  isCurrentPick: boolean
  onClick: () => void
}) {
  const { team, used } = side
  const c = teamColor(team).primary
  const clickable = !disabled && !used
  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      aria-label={used ? `${team} — already used${side.usedOn ? ` on ${side.usedOn}` : ''}` : team}
      className="flex-1 text-left transition-all relative"
      style={{
        padding: '12px 14px',
        cursor: clickable ? 'pointer' : 'not-allowed',
        opacity: used || disabled ? 0.45 : 1,
        background: selected ? 'var(--surface-sunken)' : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <SeedMark seed={side.seed} rank={side.rank} />
        <span className="team-chip-swatch" style={{ background: used || disabled ? 'var(--muted)' : c }}>{team.slice(0, 3)}</span>
        <span className="font-bold text-sm" style={{ color: used || disabled ? 'var(--muted)' : 'var(--dark)' }}>{team}</span>
        {selected && <span className="ml-auto text-sm" style={{ color: c }}>✓</span>}
        {isCurrentPick && !selected && <span className="ml-auto text-xs font-bold" style={{ color: 'var(--green)' }}>PICKED</span>}
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {side.record && <span className="text-xs tnum" style={{ color: 'var(--muted)' }}>{side.record}</span>}
        {used && (
          <span className="text-xs font-semibold tracking-wider" style={{ color: 'var(--red)' }}>
            USED{side.usedOn ? ` · ${side.usedOn}` : ''}
          </span>
        )}
      </div>
    </button>
  )
}

export default function PickForm({
  slateId,
  periodLabel,
  pickHeading,
  mode,
  gameRows,
  usedTeams,
  currentPick,
}: Props) {
  const router = useRouter()
  const caps = capabilitiesFor(mode)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  const isChange = !!currentPick
  const anySelectable = gameRows.some((r) => (!r.locked && !r.away.used) || (!r.locked && !r.home.used))

  // Only offer filters the data can actually honour — a Top 25 chip that
  // filters on a column nobody populated is worse than no chip.
  const availableFilters = useMemo<Filter[]>(() => {
    const list: Filter[] = ['all', 'available']
    const hasRanked = gameRows.some((r) => r.away.rank != null || r.home.rank != null || r.away.seed != null || r.home.seed != null)
    if (hasRanked) list.push('ranked')
    if (gameRows.some((r) => r.away.used || r.home.used)) list.push('used')
    return list
  }, [gameRows])

  const matches = (row: GameRow): boolean => {
    switch (filter) {
      case 'available':
        return !row.away.used || !row.home.used
      case 'ranked':
        return [row.away, row.home].some((s) => s.seed != null || s.rank != null)
      case 'used':
        return row.away.used || row.home.used
      default:
        return true
    }
  }

  // Games in tip order, grouped under their tip time. Anything ESPN hasn't
  // timed yet falls into a single TBD group at the end — it has no honest
  // place on a chronological board.
  const groups = useMemo(() => {
    const visible = gameRows.filter(matches)
    const timed = visible.filter((r) => !r.timeTbd)
    const tbd = visible.filter((r) => r.timeTbd)

    const byTime = new Map<string, { key: string; label: string; sort: number; rows: GameRow[] }>()
    for (const row of timed.slice().sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())) {
      const label = formatTipSlot(row.kickoff)
      const existing = byTime.get(label)
      if (existing) existing.rows.push(row)
      else byTime.set(label, { key: label, label, sort: new Date(row.kickoff).getTime(), rows: [row] })
    }
    const out = [...byTime.values()].sort((a, b) => a.sort - b.sort)
    if (tbd.length > 0) out.push({ key: 'tbd', label: 'Time TBD', sort: Infinity, rows: tbd })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameRows, filter])

  async function handleSubmit() {
    if (!selected || !confirmed) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: slateId, team: selected }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to submit pick'); return }
      setSuccess(true)
      setTimeout(() => router.refresh(), 1800)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (success) return (
    <div className="text-center py-16">
      <p className="font-display text-6xl" style={{ color: 'var(--green)' }}>{isChange ? 'PICK UPDATED!' : 'LOCKED IN!'}</p>
      <p className="text-sm mt-4" style={{ color: 'var(--muted)' }}>
        {selected} — {periodLabel}.
      </p>
    </div>
  )

  if (!isChange && !anySelectable) return (
    <div className="text-center py-16">
      <p className="font-display text-4xl" style={{ color: 'var(--dark)' }}>ALL TEAMS LOCKED</p>
      <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>The deadline has passed, or you&apos;ve used every team playing today.</p>
    </div>
  )

  return (
    <div className="space-y-8">
      <div>
        <p className="font-display text-4xl leading-tight" style={{ color: 'var(--dark)' }}>{periodLabel.toUpperCase()}</p>
        <p className="mt-1 eyebrow">{gameRows.length} eligible {gameRows.length === 1 ? 'game' : 'games'}</p>
      </div>

      {currentPick && (
        <div className="border p-6" style={{ borderColor: 'var(--green)', borderWidth: 2 }}>
          <p className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--green)' }}>
            ✓ Your Pick
          </p>
          <div className="flex items-center gap-3 mt-3">
            <span className="team-chip-swatch" style={{ background: teamColor(currentPick.team).primary, width: 32, height: 32, fontSize: 11, borderRadius: 7 }}>{currentPick.team.slice(0, 3)}</span>
            <p className="font-display text-3xl leading-none" style={{ color: 'var(--dark)' }}>
              {currentPick.team}
            </p>
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--muted)' }}>
            You can still change this pick{currentPick.deadline ? ` until it locks ${formatLockTime(currentPick.deadline)}` : ''}. Select a different team below to switch.
          </p>
        </div>
      )}

      {isChange && !anySelectable && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>No other teams are available to switch to.</p>
      )}

      <div>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <p className="eyebrow">{isChange ? 'Switch to a different team' : pickHeading}</p>
          {usedTeams.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{usedTeams.length} {usedTeams.length === 1 ? 'team' : 'teams'} spent</p>
          )}
        </div>

        {availableFilters.length > 2 && (
          <div className="flex gap-1.5 flex-wrap mb-4" role="group" aria-label="Filter games">
            {availableFilters.map((f) => {
              const on = filter === f
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f)}
                  className="px-3 py-1.5 text-xs font-bold tracking-wider uppercase"
                  style={{
                    background: on ? 'var(--dark)' : 'transparent',
                    color: on ? 'var(--cream)' : 'var(--muted)',
                    border: `1px solid ${on ? 'var(--dark)' : 'var(--border)'}`,
                    borderRadius: 4,
                  }}
                >
                  {FILTER_LABEL[f]}
                </button>
              )
            })}
          </div>
        )}

        {groups.length === 0 ? (
          <p className="text-sm py-6" style={{ color: 'var(--muted)' }}>No games match that filter.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.key}>
                {/* Tip-time heading. The day reads top to bottom in the order
                    the games actually happen. */}
                <div className="flex items-center gap-3 mb-2">
                  <p className="eyebrow" style={{ color: 'var(--dark)' }}>{group.label}</p>
                  <span className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                  <span className="text-xs tnum" style={{ color: 'var(--muted)' }}>
                    {group.rows.length} {group.rows.length === 1 ? 'game' : 'games'}
                  </span>
                </div>

                <div className="space-y-2">
                  {group.rows.map((row) => {
                    const disabled = row.locked
                    // In the tournament, where the game sits in the bracket is
                    // part of the pick: a 2 vs 15 in the East First Round is a
                    // different decision from an Elite Eight game.
                    const context = caps.showTournamentRounds
                      ? [roundDisplay(row.round), caps.showRegions && row.region ? `${row.region} Region` : null]
                          .filter(Boolean)
                          .join(' · ')
                      : null
                    return (
                      <div key={row.gameId} className="card overflow-hidden" style={{ padding: 0, opacity: disabled ? 0.6 : 1 }}>
                        {context && (
                          <div
                            className="px-3 py-1 eyebrow"
                            style={{ background: 'var(--dark)', color: 'var(--cream)', fontSize: 10 }}
                          >
                            {context}
                          </div>
                        )}
                        <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
                          <TeamHalf
                            side={row.away}
                            disabled={disabled}
                            selected={selected === row.away.team}
                            isCurrentPick={currentPick?.team === row.away.team}
                            onClick={() => { setSelected(row.away.team); setConfirmed(false) }}
                          />
                          <div style={{ width: 1, background: 'var(--border)' }} />
                          <TeamHalf
                            side={row.home}
                            disabled={disabled}
                            selected={selected === row.home.team}
                            isCurrentPick={currentPick?.team === row.home.team}
                            onClick={() => { setSelected(row.home.team); setConfirmed(false) }}
                          />
                        </div>
                        <div className="px-3 py-1.5 text-xs flex items-center justify-between gap-2" style={{ background: 'var(--surface-sunken)', color: 'var(--muted)' }}>
                          <span className="truncate">
                            {row.away.team} vs. {row.home.team}
                            {row.tv ? ` · ${row.tv}` : ''}
                          </span>
                          <span className="shrink-0" style={{ color: disabled ? 'var(--red)' : 'var(--muted)' }}>
                            {disabled ? '🔒 Locked' : row.timeTbd ? 'TBD' : `Locks ${formatLockTime(row.deadline)}`}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="card p-5 space-y-4" style={{ borderColor: teamColor(selected).primary, boxShadow: `0 0 0 2px ${teamColor(selected).primary}` }}>
          <div className="flex items-center gap-3">
            <span className="team-chip-swatch" style={{ background: teamColor(selected).primary, width: 32, height: 32, fontSize: 11, borderRadius: 7 }}>{selected.slice(0, 3)}</span>
            <div>
              <p className="eyebrow" style={{ color: 'var(--muted)' }}>{isChange ? 'New Pick' : 'Your Pick'}</p>
              <p className="font-display text-2xl leading-none" style={{ color: 'var(--dark)' }}>{selected}</p>
            </div>
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span className="text-sm" style={{ color: 'var(--dark)' }}>
              I confirm this pick. Picks can be changed until the first tip of the day, then they lock for good.
            </span>
          </label>
          {error && <p className="text-sm rounded-md px-3 py-2" style={{ color: 'var(--red)', background: 'var(--red-tint)' }}>{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={!confirmed || submitting}
            className="btn-primary w-full font-display tracking-wider py-3"
          >
            {submitting ? 'LOCKING IN…' : isChange ? `SWITCH TO ${selected}` : `LOCK IN ${selected}`}
          </button>
        </div>
      )}
    </div>
  )
}
