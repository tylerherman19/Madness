'use client'

import { useMemo, useState } from 'react'
import { AUDIT_EVENT_TYPES, FAILURE_EVENTS, type AuditRow } from '@/lib/auditEvents'

const ACTOR_COLORS: Record<string, string> = {
  admin: 'var(--ink)',
  system: 'var(--muted)',
  player: 'var(--success)',
}

// Events that represent something being destroyed or a player going out —
// worth spotting at a glance while scanning the feed.
const ALERT_EVENTS = new Set(['player-deleted', 'player-eliminated', 'pool-reset'])

const DAY_MS = 24 * 60 * 60 * 1000

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function AuditLogClient({ rows, loadedAt }: { rows: AuditRow[]; loadedAt: number }) {
  const [eventType, setEventType] = useState('')
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const recentFailures = useMemo(
    () => rows.filter((r) => FAILURE_EVENTS.has(r.event_type) && loadedAt - new Date(r.created_at).getTime() < DAY_MS).length,
    [rows, loadedAt]
  )

  async function runAction(label: string, url: string) {
    setBusy(label)
    setNotice(null)
    try {
      const res = await fetch(url, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      const delivery = body.delivery ?? body
      if (!res.ok) setNotice(body.error || 'Request failed')
      else if (delivery.sent) setNotice(`Text sent.${body.text ? ` "${body.text}"` : ''}`)
      else setNotice(`Not sent: ${delivery.reason || 'unknown reason'}.${body.text ? ` Would have said: "${body.text}"` : ''}`)
    } catch {
      setNotice('Request failed')
    } finally {
      setBusy(null)
    }
  }
  const [player, setPlayer] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  // Only offer filter values that actually appear in the loaded window —
  // an empty result from a dropdown choice would just be confusing.
  const presentEvents = useMemo(
    () => [...new Set(rows.map((r) => r.event_type))].sort((a, b) =>
      (AUDIT_EVENT_TYPES[a] || a).localeCompare(AUDIT_EVENT_TYPES[b] || b)
    ),
    [rows]
  )
  const presentPlayers = useMemo(
    () => [...new Set(rows.map((r) => r.player_name).filter((n): n is string => !!n))].sort(),
    [rows]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (failuresOnly && !FAILURE_EVENTS.has(r.event_type)) return false
      if (eventType && r.event_type !== eventType) return false
      if (player && r.player_name !== player) return false
      if (q) {
        const haystack = `${r.message} ${r.player_name ?? ''} ${AUDIT_EVENT_TYPES[r.event_type] || r.event_type}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [rows, eventType, player, search, failuresOnly])

  const selectStyle = {
    borderColor: 'var(--line)',
    background: 'var(--surface)',
    color: 'var(--ink)',
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h1 className="font-display text-3xl" style={{ color: 'var(--ink)' }}>AUDIT LOG</h1>
        <p className="text-xs tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
          {filtered.length === rows.length
            ? `${rows.length} event${rows.length === 1 ? '' : 's'}`
            : `${filtered.length} of ${rows.length}`}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setFailuresOnly((v) => !v)}
          aria-pressed={failuresOnly}
          className="border rounded px-3 py-1.5 text-xs tracking-widest uppercase"
          style={{
            borderColor: recentFailures > 0 ? 'var(--danger)' : 'var(--line)',
            color: recentFailures > 0 ? 'var(--danger)' : 'var(--muted)',
            background: failuresOnly ? 'var(--surface-sunken)' : 'transparent',
          }}
        >
          {recentFailures === 0 ? 'No failures in 24h' : `${recentFailures} failure${recentFailures === 1 ? '' : 's'} in 24h`}
          {failuresOnly ? ' · showing failures' : ''}
        </button>
        <button
          onClick={() => runAction('test', '/api/admin/test-alert')}
          disabled={busy !== null}
          className="border rounded px-3 py-1.5 text-xs tracking-widest uppercase disabled:opacity-50"
          style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
        >
          {busy === 'test' ? 'Sending…' : 'Send test text'}
        </button>
        <button
          onClick={() => runAction('summary', '/api/cron/daily-summary')}
          disabled={busy !== null}
          className="border rounded px-3 py-1.5 text-xs tracking-widest uppercase disabled:opacity-50"
          style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
        >
          {busy === 'summary' ? 'Sending…' : 'Send daily summary now'}
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{notice}</p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events…"
          aria-label="Search events"
          className="border rounded px-3 py-2 text-sm"
          style={selectStyle}
        />
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          aria-label="Filter by event type"
          className="border rounded px-3 py-2 text-sm"
          style={selectStyle}
        >
          <option value="">All events</option>
          {presentEvents.map((t) => (
            <option key={t} value={t}>{AUDIT_EVENT_TYPES[t] || t}</option>
          ))}
        </select>
        <select
          value={player}
          onChange={(e) => setPlayer(e.target.value)}
          aria-label="Filter by player"
          className="border rounded px-3 py-2 text-sm"
          style={selectStyle}
        >
          <option value="">All players</option>
          {presentPlayers.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      {(eventType || player || search || failuresOnly) && (
        <button
          onClick={() => { setEventType(''); setPlayer(''); setSearch(''); setFailuresOnly(false) }}
          className="mt-3 text-xs tracking-widest uppercase underline"
          style={{ color: 'var(--muted)' }}
        >
          Clear filters
        </button>
      )}

      {rows.length === 0 ? (
        <p className="mt-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Nothing logged yet. Events appear here as they happen.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
          No events match those filters.
        </p>
      ) : (
        <ul className="mt-6 border-t" style={{ borderColor: 'var(--line)' }}>
          {filtered.map((row) => {
            const isOpen = expanded === row.id
            const hasDetails = row.details && Object.keys(row.details).length > 0
            return (
              <li key={row.id} className="border-b py-3" style={{ borderColor: 'var(--line)' }}>
                <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
                  <span className="font-mono text-xs shrink-0 w-32" style={{ color: 'var(--muted)' }}>
                    {formatWhen(row.created_at)}
                  </span>
                  <span
                    className="text-[10px] tracking-widest uppercase shrink-0 border rounded px-1.5 py-0.5"
                    style={{ color: ACTOR_COLORS[row.actor], borderColor: 'var(--line)' }}
                  >
                    {row.actor}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm"
                      style={{ color: ALERT_EVENTS.has(row.event_type) || FAILURE_EVENTS.has(row.event_type) ? 'var(--danger)' : 'var(--ink)' }}
                    >
                      {row.message}
                    </p>
                    <p className="text-[11px] tracking-widest uppercase mt-0.5" style={{ color: 'var(--muted)' }}>
                      {AUDIT_EVENT_TYPES[row.event_type] || row.event_type}
                      {hasDetails && (
                        <button
                          onClick={() => setExpanded(isOpen ? null : row.id)}
                          aria-expanded={isOpen}
                          className="ml-2 underline"
                          style={{ color: 'var(--muted)' }}
                        >
                          {isOpen ? 'hide details' : 'details'}
                        </button>
                      )}
                    </p>
                    {isOpen && hasDetails && (
                      <pre
                        className="mt-2 text-xs overflow-x-auto rounded p-2"
                        style={{ background: 'var(--surface-sunken)', color: 'var(--ink)' }}
                      >
                        {JSON.stringify(row.details, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
