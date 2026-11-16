'use client'

import { useRef, useState } from 'react'
import { useViewerTimeZone } from '@/app/components/LocalTime'
import TeamLogo from '@/app/components/TeamLogo'
import { formatClock } from '@/lib/deadline'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import type { GameRow, SavedPick } from './PickForm'
import s from '@/app/components/pp.module.css'

const rule = 'New for 2027: Choose two teams from either day of the Elite Eight. Submit both before Saturday’s first tip.'

export default function EliteEightForm({ gameRows, savedPicks, locked, resultPending, teamBrands }: {
  gameRows: GameRow[]; savedPicks: SavedPick[]; locked: boolean; resultPending: boolean; teamBrands: TeamBrandDirectory
}) {
  const zone = useViewerTimeZone()
  const [saved, setSaved] = useState(savedPicks)
  const [selected, setSelected] = useState(() => savedPicks.map(p => p.team))
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const request = useRef<string | null>(null)
  const name = (team: string) => brandFor(team, teamBrands).name
  const games = [...gameRows].sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  const lockedAt = games[0]?.deadline
  const changed = saved.length !== 2 || selected.some(team => !saved.some(p => p.team === team))
  const disabled = selected.length !== 2 || locked || resultPending || busy || (!changed && !uncertain)
  const showHint = selected.length !== 2 && !locked

  function toggle(team: string) {
    if (busy || uncertain || locked) return
    setSelected(current => current.includes(team) ? current.filter(t => t !== team) :
      current.length === 2 ? current : [...current, team])
    setMessage('')
    request.current = null
  }

  async function submit() {
    if (disabled) return
    // Keep unchanged selections in their original slots; remaining choices
    // take the remaining slot. Same-day and cross-day edits use the same RPC.
    const availableSlots = saved.filter(p => !selected.includes(p.team))
    const picks = selected.map(team => {
      const game = games.find(g => g.home.team === team || g.away.team === team)
      const old = saved.find(p => p.team === team) ?? availableSlots.shift()
      return { team, slate_id: game?.slateId, pick_id: old?.id ?? null, expected: old?.updatedAt ?? null }
    })
    if (picks.some(p => !p.slate_id)) {
      setError(true)
      setMessage('The schedule has changed. Refresh, then choose your two teams again.')
      return
    }
    request.current ??= crypto.randomUUID()
    setBusy(true)
    setError(false)
    try {
      const response = await fetch('/api/picks/elite-eight', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: request.current, picks }),
        signal: AbortSignal.timeout(12000),
      })
      const result = await response.json()
      if (response.status >= 500) throw new Error('Save not confirmed')
      if (!response.ok) {
        setError(true)
        setMessage(result.error ?? 'Neither pick was saved.')
        setUncertain(false)
        request.current = null
        return
      }
      const next: SavedPick[] = result.picks.map((p: { id: string; slate_id: string; team: string; updated_at: string }) =>
        ({ id: p.id, team: p.team, slateId: p.slate_id, updatedAt: p.updated_at, editable: true, autoAssigned: false }))
      setSaved(next)
      setUncertain(false)
      request.current = null
      setMessage(`Both picks saved: ${next.map(p => name(p.team)).join(' and ')}.`)
      // Keep the receipt visible; the next navigation fetches fresh standings.
    } catch {
      setError(true)
      setUncertain(true)
      setMessage('Couldn’t confirm the save. Retry these same two picks to check the receipt.')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <p className={s.kicker}>March 27–28, 2027</p>
    <h1 className={s.title}>Elite Eight picks</h1>
    <p className={s.notice}>{rule} Both teams must win for you to advance.</p>
    {lockedAt && <p className={s.availLine}><b>Saturday deadline:</b> {formatClock(lockedAt, zone)}</p>}
    {locked && <p className={s.notice}>{saved.length === 2 ? 'Your two picks are locked.' : 'Picks are closed or the full Elite Eight schedule is still being confirmed.'}</p>}
    {resultPending && !locked && <p className={s.notice}>We’re waiting for your previous win to be confirmed before you can submit.</p>}
    <div className={s.pickGrid} role="group" aria-label="Elite Eight teams">
      {games.map(game => <div className={s.pickGame} key={game.gameId}>
        <p className={s.pickMeta}><b>{new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' }).format(new Date(game.kickoff))} · {formatClock(game.kickoff, zone)}</b></p>
        {[game.away, game.home].map(side => <button type="button" key={side.team} className={s.teamBtn}
          data-state={selected.includes(side.team) ? 'selected' : side.used ? 'used' : undefined}
          aria-pressed={selected.includes(side.team)} disabled={busy || uncertain || locked || side.used || (!selected.includes(side.team) && selected.length === 2)}
          onClick={() => toggle(side.team)}>
          <span className={s.teamTag}>{side.seed}</span><TeamLogo team={side.team} brands={teamBrands} size={26}/>
          <span className={s.teamName}>{name(side.team)}</span>
        </button>)}
      </div>)}
    </div>
    <div className={s.eliteActions}>
      <p aria-live="polite"><b>{selected.length} of 2 selected</b>{selected.length ? `: ${selected.map(name).join(' and ')}` : ''}</p>
      <span className={s.eliteSubmit} data-hint={showHint} tabIndex={showHint ? 0 : undefined} aria-describedby={showHint ? 'elite-submit-hint' : undefined}>
        <button className={s.cta} type="button" disabled={disabled} onClick={() => void submit()}>
          {busy ? 'Saving both picks…' : uncertain ? 'Retry both picks' : saved.length ? 'Save both picks' : 'Submit both picks'}
        </button>
        {showHint && <span className={s.eliteTip} id="elite-submit-hint" role="tooltip">{rule}</span>}
      </span>
    </div>
    {message && <p className={error ? s.alert : s.notice} role={error ? 'alert' : 'status'}>{message}</p>}
  </>
}
