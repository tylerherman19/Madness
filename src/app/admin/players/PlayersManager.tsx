'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { Player } from '@/types'
import { teamColor } from '@/lib/teamColors'
import { apiRequest } from '@/lib/clientApi'
import Dialog from '@/app/components/Dialog'

interface Props {
  players: Player[]
  activeWeekId: string | null
  activeWeekNumber: number | null
  teams: string[]
  currentPicks: Record<string, string>
  weeksSurvived: Record<string, number>
}

function actionBtn(color: 'neutral' | 'red' | 'green') {
  const c = color === 'red' ? 'var(--red)' : color === 'green' ? 'var(--green)' : 'var(--dark)'
  return {
    borderColor: color === 'neutral' ? 'var(--border)' : c,
    color: c,
  }
}

export default function PlayersManager({ players, activeWeekId, activeWeekNumber, teams, currentPicks, weeksSurvived }: Props) {
  const router = useRouter()
  const [message, setMessage] = useState('')
  const [csvText, setCsvText] = useState('')
  const [importing, setImporting] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [pickModal, setPickModal] = useState<{ player: Player; team: string } | null>(null)
  const [submittingPick, setSubmittingPick] = useState(false)
  const [editModal, setEditModal] = useState<{ id: string; full_name: string; email: string } | null>(null)
  const [editError, setEditError] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState(false)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newPlayer, setNewPlayer] = useState({ full_name: '', email: '', password: '' })
  const [addError, setAddError] = useState('')
  const [addingPlayer, setAddingPlayer] = useState(false)
  const [resettingPlayerId, setResettingPlayerId] = useState<string | null>(null)
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null)

  const query = search.trim().toLowerCase()
  const filtered = query
    ? players.filter((p) => p.full_name.toLowerCase().includes(query) || p.email.toLowerCase().includes(query))
    : players

  const allIds = filtered.map((p) => p.id)
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
  const someSelected = selected.size > 0

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(allIds))
  }

  async function bulkSetPaid(paid: boolean) {
    if (!someSelected || bulkWorking) return
    setBulkWorking(true)
    setMessage('')
    const ids = [...selected]
    try {
      const results = await Promise.all(
        ids.map((id) => apiRequest(`/api/players/${id}`, { method: 'PATCH', body: { paid } }))
      )
      const failed = results.filter((r) => !r.ok).length
      setMessage(
        failed
          ? `Marked ${ids.length - failed} of ${ids.length} as ${paid ? 'paid' : 'unpaid'}; ${failed} failed. Refresh and retry the rest.`
          : `Marked ${ids.length} player${ids.length !== 1 ? 's' : ''} as ${paid ? 'paid' : 'unpaid'}`
      )
      setSelected(new Set())
      router.refresh()
    } finally {
      setBulkWorking(false)
    }
  }

  async function togglePaid(playerId: string, current: boolean) {
    if (busyPlayerId) return
    setBusyPlayerId(playerId)
    try {
      const res = await apiRequest(`/api/players/${playerId}`, { method: 'PATCH', body: { paid: !current } })
      if (res.ok) router.refresh()
      else setMessage(`Failed to update payment: ${res.error}`)
    } finally {
      setBusyPlayerId(null)
    }
  }

  async function requestPasswordReset(playerId: string, fullName: string) {
    if (resettingPlayerId) return
    setResettingPlayerId(playerId)
    setMessage('')
    try {
      const res = await apiRequest<{ emailSent?: boolean }>(`/api/players/${playerId}/regen-pin`, { method: 'POST' })
      if (res.ok) {
        setMessage(res.data.emailSent
          ? `Password reset email sent to ${fullName}`
          : `Reset request created for ${fullName}. Email delivery is off, so no email was sent.`)
      } else {
        setMessage(res.error || 'Failed to create reset request')
      }
    } finally {
      setResettingPlayerId(null)
    }
  }

  async function bulkDelete() {
    if (!someSelected || bulkWorking) return
    const ids = [...selected]
    if (!confirm(`Permanently delete ${ids.length} player${ids.length !== 1 ? 's' : ''}? This removes all their picks. A snapshot of each entry is kept in the audit log.`)) return
    setBulkWorking(true)
    setMessage('')
    try {
      const results = await Promise.all(
        ids.map((id) => apiRequest(`/api/players/${id}`, { method: 'DELETE' }))
      )
      const failed = results.filter((r) => !r.ok).length
      setMessage(
        failed
          ? `Deleted ${ids.length - failed} player${ids.length - failed !== 1 ? 's' : ''}, ${failed} failed`
          : `Deleted ${ids.length} player${ids.length !== 1 ? 's' : ''}`
      )
      setSelected(new Set())
      router.refresh()
    } finally {
      setBulkWorking(false)
    }
  }

  async function deletePlayer(player: Player) {
    if (busyPlayerId) return
    if (!confirm(`Permanently delete ${player.full_name}? This removes all their picks. A snapshot of the entry is kept in the audit log.`)) return
    setBusyPlayerId(player.id)
    try {
      const res = await apiRequest(`/api/players/${player.id}`, { method: 'DELETE' })
      if (res.ok) {
        setMessage(`${player.full_name} deleted`)
        setSelected((prev) => { const next = new Set(prev); next.delete(player.id); return next })
        router.refresh()
      } else {
        setMessage(`Failed to delete player: ${res.error}`)
      }
    } finally {
      setBusyPlayerId(null)
    }
  }

  async function toggleElimination(player: Player) {
    if (busyPlayerId) return
    let reason: string | null = null
    if (player.status === 'alive') {
      // prompt() returns null on Cancel — that must abort, not eliminate.
      const entered = prompt(`Eliminate ${player.full_name}? Enter a reason (shown in recap):`, 'Admin correction')
      if (entered === null) return
      reason = entered.trim().slice(0, 200) || 'Admin correction'
    } else if (!confirm(`Restore ${player.full_name} to alive?`)) {
      return
    }

    setBusyPlayerId(player.id)
    try {
      const res = await apiRequest(`/api/players/${player.id}`, {
        method: 'PATCH',
        body: {
          status: player.status === 'eliminated' ? 'alive' : 'eliminated',
          elimination_reason: reason,
          elimination_slate: player.status === 'eliminated' ? null : activeWeekNumber,
        },
      })
      if (res.ok) {
        setMessage(`${player.full_name} ${player.status === 'alive' ? 'eliminated' : 'restored'}`)
        router.refresh()
      } else {
        setMessage(`Failed to update ${player.full_name}: ${res.error}`)
      }
    } finally {
      setBusyPlayerId(null)
    }
  }

  async function saveEdit() {
    if (!editModal || savingEdit) return
    setSavingEdit(true)
    setEditError('')
    try {
      const res = await apiRequest(`/api/players/${editModal.id}`, {
        method: 'PATCH',
        body: { full_name: editModal.full_name.trim(), email: editModal.email.trim() },
      })
      if (res.ok) {
        setMessage('Player updated')
        setEditModal(null)
        router.refresh()
      } else {
        setEditError(res.error || 'Failed to update player')
      }
    } finally {
      setSavingEdit(false)
    }
  }

  async function submitAdminPick() {
    if (!pickModal || !activeWeekId || submittingPick) return
    setSubmittingPick(true)
    try {
      const res = await apiRequest('/api/picks', {
        method: 'POST',
        body: {
          slate_id: activeWeekId,
          team: pickModal.team,
          player_id_override: pickModal.player.id,
          submitted_by_admin: true,
        },
      })
      if (res.ok) {
        setMessage(`Pick submitted for ${pickModal.player.full_name}: ${pickModal.team}`)
        setPickModal(null)
        router.refresh()
      } else {
        setMessage(`Error: ${res.error}`)
      }
    } finally {
      setSubmittingPick(false)
    }
  }

  async function handleImport() {
    if (!csvText.trim() || importing) return
    setImporting(true)
    setMessage('')
    try {
      const res = await apiRequest<{ count: number; skipped?: number; errors?: string[] }>('/api/import', {
        method: 'POST',
        body: { csv: csvText },
        timeoutMs: 300_000,
      })
      if (res.ok) {
        const { count, skipped = 0, errors = [] } = res.data
        const parts = [`Imported ${count} player${count === 1 ? '' : 's'}`]
        if (skipped) parts.push(`${skipped} already existed`)
        if (errors.length) parts.push(`${errors.length} failed: ${errors.join('; ')}`)
        setMessage(parts.join(' · '))
        // Keep the CSV in the box when rows failed so they can be fixed and re-run;
        // rows that were created are skipped on the next import.
        if (errors.length === 0) {
          setCsvText('')
          setShowImport(false)
        }
        router.refresh()
      } else {
        setMessage(`Error: ${res.error}`)
      }
    } finally {
      setImporting(false)
    }
  }

  async function addPlayer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (addingPlayer) return
    setAddingPlayer(true)
    setAddError('')
    setMessage('')
    try {
      const res = await apiRequest('/api/admin/players', { method: 'POST', body: newPlayer })
      if (res.ok) {
        setMessage(`Added ${newPlayer.full_name.trim()}`)
        setNewPlayer({ full_name: '', email: '', password: '' })
        setShowAdd(false)
        router.refresh()
      } else {
        setAddError(res.error || 'Failed to add player')
      }
    } finally {
      setAddingPlayer(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Add and import controls */}
      <div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { setShowAdd(true); setAddError('') }}
            className="btn-primary text-sm font-semibold px-4 py-2"
          >
            Add Player
          </button>
          <button
            onClick={() => setShowImport(!showImport)}
            className="rounded-lg border px-4 py-2 text-sm font-semibold"
            style={{ borderColor: 'var(--border)', color: 'var(--dark)' }}
          >
            Import Players from CSV
          </button>
        </div>

        {showImport && (
          <div className="card mt-4 p-4 space-y-3">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Paste CSV with headers:{' '}
              <code style={{ color: 'var(--dark)' }}>Full Name, Phone, Email, Venmo, Paid, Password</code>
            </p>
            <textarea
              aria-label="Players CSV"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder="Full Name,Phone,Email,Venmo,Paid,Password&#10;John Smith,555-1234,john@example.com,@johnsmith,yes,full-court-press"
              rows={8}
              className="field w-full px-3 py-2 text-sm font-mono"
              style={{ color: 'var(--dark)' }}
            />
            <div className="flex gap-3">
              <button
                onClick={handleImport}
                disabled={importing || !csvText.trim()}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50"
                style={{ background: 'var(--green)' }}
              >
                {importing ? 'Importing…' : 'Import Players'}
              </button>
              <button
                onClick={() => setShowImport(false)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className="text-sm font-medium" style={{ color: message.toLowerCase().includes('fail') || message.toLowerCase().includes('error') ? 'var(--red)' : 'var(--green)' }}>
          {message}
        </p>
      )}

      {/* Bulk actions */}
      {someSelected && (
        <div className="card flex items-center gap-3 px-4 py-2.5">
          <span className="text-sm" style={{ color: 'var(--dark)' }}>{selected.size} selected</span>
          <button
            onClick={() => bulkSetPaid(true)}
            disabled={bulkWorking}
            className="pill disabled:opacity-50"
            style={{ background: 'var(--green-tint)', color: 'var(--green)' }}
          >
            Mark Paid
          </button>
          <button
            onClick={() => bulkSetPaid(false)}
            disabled={bulkWorking}
            className="pill disabled:opacity-50"
            style={{ background: 'var(--red-tint)', color: 'var(--red)' }}
          >
            Mark Unpaid
          </button>
          <button
            onClick={bulkDelete}
            disabled={bulkWorking}
            className="pill disabled:opacity-50"
            style={{ background: 'var(--red-tint)', color: 'var(--red)' }}
          >
            Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs"
            style={{ color: 'var(--muted)' }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          aria-label="Search players"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search players by name or email…"
          className="field w-full max-w-sm px-3 py-2 text-sm"
          style={{ color: 'var(--dark)' }}
        />
        {query && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {filtered.length} of {players.length}
          </span>
        )}
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-3">
        {filtered.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {query ? <>No players match &ldquo;{search}&rdquo;.</> : 'No players yet. Add one above or share the signup page.'}
          </p>
        ) : null}
        {filtered.map((p) => {
          const pick = currentPicks[p.id]
          const slates = weeksSurvived[p.id] || 0
          return (
            <div
              key={p.id}
              className="card p-4 space-y-3"
              style={selected.has(p.id) ? { borderColor: 'var(--dark)', borderWidth: 2 } : {}}
            >
              {/* Top row: checkbox + name + status */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  aria-label={`Select ${p.full_name}`}
                  checked={selected.has(p.id)}
                  onChange={() => toggleSelect(p.id)}
                  className="shrink-0"
                />
                <span className="font-medium flex-1" style={{ color: 'var(--dark)' }}>{p.full_name}</span>
                <span className={`pill ${p.status === 'alive' ? 'pill-alive' : 'pill-out'}`}>
                  {p.status === 'alive' ? 'Alive' : 'Out'}
                </span>
              </div>

              {/* Second row: paid + slate pick */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => togglePaid(p.id, p.paid)}
                  disabled={busyPlayerId === p.id}
                  aria-label={`${p.full_name}: ${p.paid ? 'paid' : 'unpaid'}. Toggle payment status`}
                  className="pill"
                  style={{ background: p.paid ? 'var(--green-tint)' : 'var(--red-tint)', color: p.paid ? 'var(--green)' : 'var(--red)' }}
                >
                  {p.paid ? 'Paid' : 'Unpaid'}
                </button>
                {pick ? (
                  <span className="team-chip-swatch" style={{ background: teamColor(pick).primary, width: 'auto', padding: '3px 8px', borderRadius: 6 }}>{pick}</span>
                ) : p.status === 'alive' ? (
                  <span className="text-xs" style={{ color: 'var(--red)' }}>pending pick</span>
                ) : null}
              </div>

              {/* Third row: slates survived */}
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{slates > 0 ? `${slates} slate${slates !== 1 ? 's' : ''} survived` : 'No slates survived'}</p>

              {/* Bottom row: actions */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => { setEditModal({ id: p.id, full_name: p.full_name, email: p.email }); setEditError('') }}
                  className="rounded border px-2 py-1 text-xs"
                  style={actionBtn('neutral')}
                >
                  Edit
                </button>
                <button
                  onClick={() => requestPasswordReset(p.id, p.full_name)}
                  disabled={resettingPlayerId === p.id}
                  className="rounded border px-2 py-1 text-xs"
                  style={actionBtn('neutral')}
                >
                  {resettingPlayerId === p.id ? 'Creating request…' : 'Send Reset Email'}
                </button>
                <button
                  onClick={() => toggleElimination(p)}
                  disabled={busyPlayerId === p.id}
                  className="rounded border px-2 py-1 text-xs"
                  style={actionBtn(p.status === 'alive' ? 'red' : 'green')}
                >
                  {p.status === 'alive' ? 'Eliminate' : 'Restore'}
                </button>
                {activeWeekId && p.status === 'alive' && (
                  <button
                    onClick={() => setPickModal({ player: p, team: pick || '' })}
                    className="rounded border px-2 py-1 text-xs"
                    style={actionBtn('neutral')}
                  >
                    {pick ? 'Change Pick' : 'Submit Pick'}
                  </button>
                )}
                <button
                  onClick={() => deletePlayer(p)}
                  disabled={busyPlayerId === p.id}
                  className="rounded border px-2 py-1 text-xs"
                  style={actionBtn('red')}
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Players table */}
      <div className="hidden sm:block card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border)' }} className="text-left">
              <th className="px-4 py-3">
                <input type="checkbox" aria-label="Select all players" checked={allSelected} onChange={toggleSelectAll} />
              </th>
              <th className="px-4 py-3 eyebrow">Name</th>
              <th className="px-4 py-3 eyebrow">Status</th>
              <th className="px-4 py-3 eyebrow">Wks</th>
              <th className="px-4 py-3 eyebrow">This Slate</th>
              <th className="px-4 py-3 eyebrow">Paid</th>
              <th className="px-4 py-3 eyebrow">Email</th>
              <th className="px-4 py-3 eyebrow">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
                  {query ? <>No players match &ldquo;{search}&rdquo;.</> : 'No players yet. Add one above or share the signup page.'}
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const pick = currentPicks[p.id]
              const slates = weeksSurvived[p.id] || 0
              return (
                <tr
                  key={p.id}
                  className="row-hover"
                  style={{
                    borderBottom: '1px solid var(--border)',
                    background: selected.has(p.id) ? 'var(--surface-sunken)' : 'transparent',
                    opacity: p.status === 'eliminated' ? 0.65 : 1,
                  }}
                >
                  <td className="px-4 py-3">
                    <input type="checkbox" aria-label={`Select ${p.full_name}`} checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} />
                  </td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--dark)' }}>{p.full_name}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${p.status === 'alive' ? 'pill-alive' : 'pill-out'}`}>
                      {p.status === 'alive' ? 'Alive' : 'Out'}
                    </span>
                  </td>
                  <td className="px-4 py-3 tnum" style={{ color: 'var(--muted)' }}>{slates}</td>
                  <td className="px-4 py-3">
                    {pick ? (
                      <span className="team-chip-swatch" style={{ background: teamColor(pick).primary, width: 'auto', padding: '3px 8px', borderRadius: 6 }}>{pick}</span>
                    ) : p.status === 'alive' ? (
                      <span className="text-xs font-semibold" style={{ color: 'var(--red)' }}>pending</span>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => togglePaid(p.id, p.paid)}
                  disabled={busyPlayerId === p.id}
                  aria-label={`${p.full_name}: ${p.paid ? 'paid' : 'unpaid'}. Toggle payment status`}
                      className="pill"
                      style={{ background: p.paid ? 'var(--green-tint)' : 'var(--red-tint)', color: p.paid ? 'var(--green)' : 'var(--red)' }}
                    >
                      {p.paid ? 'Paid' : 'Unpaid'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>{p.email}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => { setEditModal({ id: p.id, full_name: p.full_name, email: p.email }); setEditError('') }}
                        className="rounded border px-2 py-0.5 text-xs"
                        style={actionBtn('neutral')}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => requestPasswordReset(p.id, p.full_name)}
                        disabled={resettingPlayerId === p.id}
                        className="rounded border px-2 py-0.5 text-xs"
                        style={actionBtn('neutral')}
                      >
                        {resettingPlayerId === p.id ? 'Creating request…' : 'Send Reset Email'}
                      </button>
                      <button
                        onClick={() => toggleElimination(p)}
                  disabled={busyPlayerId === p.id}
                        className="rounded border px-2 py-0.5 text-xs"
                        style={actionBtn(p.status === 'alive' ? 'red' : 'green')}
                      >
                        {p.status === 'alive' ? 'Eliminate' : 'Restore'}
                      </button>
                      {activeWeekId && p.status === 'alive' && (
                        <button
                          onClick={() => setPickModal({ player: p, team: currentPicks[p.id] || '' })}
                          className="rounded border px-2 py-0.5 text-xs"
                          style={actionBtn('neutral')}
                        >
                          {currentPicks[p.id] ? 'Change Pick' : 'Submit Pick'}
                        </button>
                      )}
                      <button
                        onClick={() => deletePlayer(p)}
                  disabled={busyPlayerId === p.id}
                        className="rounded border px-2 py-0.5 text-xs"
                        style={actionBtn('red')}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Late player signup modal */}
      {showAdd && (
        <Dialog title="Add Player" onClose={() => { if (!addingPlayer) setShowAdd(false) }}>
          <form onSubmit={addPlayer} className="space-y-4">
            <div>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                This bypasses the public signup deadline. Give the player the password you set below.
              </p>
            </div>
            <div>
              <label className="eyebrow block mb-1" htmlFor="new-player-name">Full Name</label>
              <input
                id="new-player-name"
                type="text"
                value={newPlayer.full_name}
                onChange={(event) => setNewPlayer({ ...newPlayer, full_name: event.target.value })}
                className="field w-full px-3 py-2 text-sm"
                style={{ color: 'var(--dark)' }}
                autoFocus
                required
                maxLength={80}
              />
            </div>
            <div>
              <label className="eyebrow block mb-1" htmlFor="new-player-password">Temporary Password</label>
              <input
                id="new-player-password"
                type="password"
                value={newPlayer.password}
                onChange={(event) => setNewPlayer({ ...newPlayer, password: event.target.value })}
                className="field w-full px-3 py-2 text-sm"
                style={{ color: 'var(--dark)' }}
                required
                minLength={8}
                maxLength={72}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="eyebrow block mb-1" htmlFor="new-player-email">Email</label>
              <input
                id="new-player-email"
                type="email"
                value={newPlayer.email}
                onChange={(event) => setNewPlayer({ ...newPlayer, email: event.target.value })}
                className="field w-full px-3 py-2 text-sm"
                style={{ color: 'var(--dark)' }}
                required
                maxLength={254}
              />
            </div>
            {addError && <p role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{addError}</p>}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={addingPlayer || !newPlayer.full_name.trim() || !newPlayer.email.trim() || newPlayer.password.length < 8}
                className="btn-primary flex-1 py-2 font-semibold disabled:opacity-50"
              >
                {addingPlayer ? 'Adding…' : 'Add Player'}
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                disabled={addingPlayer}
                className="flex-1 rounded-lg border py-2"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {/* Admin pick modal */}
      {pickModal && (
        <Dialog
          title={<>{currentPicks[pickModal.player.id] ? 'Change Pick' : 'Submit Pick'} — {pickModal.player.full_name}</>}
          onClose={() => { if (!submittingPick) setPickModal(null) }}
        >
            {currentPicks[pickModal.player.id] && (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Current pick: <span className="font-mono font-bold" style={{ color: 'var(--dark)' }}>{currentPicks[pickModal.player.id]}</span>
              </p>
            )}
            <div>
              <label className="eyebrow block mb-1" htmlFor="admin-pick-team">Team</label>
              <select
                id="admin-pick-team"
                value={pickModal.team}
                onChange={(e) => setPickModal({ ...pickModal, team: e.target.value })}
                className="field w-full px-3 py-2"
                style={{ color: 'var(--dark)' }}
              >
                <option value="">Select team…</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <button
                onClick={submitAdminPick}
                disabled={!pickModal.team || submittingPick}
                className="btn-primary flex-1 py-2 font-semibold disabled:opacity-50"
              >
                {submittingPick ? 'Submitting…' : currentPicks[pickModal.player.id] ? 'Change Pick' : 'Submit Pick'}
              </button>
              <button
                onClick={() => setPickModal(null)}
                disabled={submittingPick}
                className="flex-1 rounded-lg border py-2"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                Cancel
              </button>
            </div>
        </Dialog>
      )}

      {/* Edit player modal */}
      {editModal && (
        <Dialog title="Edit Player" onClose={() => { if (!savingEdit) setEditModal(null) }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Name is the login key — changing it changes what they type in to log in.
            </p>
            <div>
              <label className="eyebrow block mb-1" htmlFor="edit-player-name">Full Name</label>
              <input
                id="edit-player-name"
                type="text"
                maxLength={80}
                value={editModal.full_name}
                onChange={(e) => setEditModal({ ...editModal, full_name: e.target.value })}
                className="field w-full px-3 py-2 text-sm"
                style={{ color: 'var(--dark)' }}
              />
            </div>
            <div>
              <label className="eyebrow block mb-1" htmlFor="edit-player-email">Email</label>
              <input
                id="edit-player-email"
                type="email"
                maxLength={254}
                value={editModal.email}
                onChange={(e) => setEditModal({ ...editModal, email: e.target.value })}
                className="field w-full px-3 py-2 text-sm"
                style={{ color: 'var(--dark)' }}
              />
            </div>
            {editError && <p role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{editError}</p>}
            <div className="flex gap-3">
              <button
                onClick={saveEdit}
                disabled={savingEdit || !editModal.full_name.trim() || !editModal.email.trim()}
                className="btn-primary flex-1 py-2 font-semibold disabled:opacity-50"
              >
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setEditModal(null)}
                disabled={savingEdit}
                className="flex-1 rounded-lg border py-2"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                Cancel
              </button>
            </div>
        </Dialog>
      )}
    </div>
  )
}
