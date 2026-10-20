'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { tipTime } from '@/lib/poolTheme'
import LockCountdown from '@/app/components/LockCountdown'
import s from '@/app/components/pp.module.css'

export interface GameSide {
  team: string
  used: boolean
  usedOn: string | null
  // Seed in the tournament, AP rank otherwise; null when there is none.
  seed: number | null
  rank: number | null
  record: string | null
}

export interface GameRow {
  gameId: string
  kickoff: string
  timeTbd: boolean
  round: string | null
  region: string | null
  // Region in the tournament, conference otherwise.
  group: string | null
  venue: string | null
  tv: string | null
  away: GameSide
  home: GameSide
  deadline: string
  locked: boolean
}

export interface SavedPick {
  id: string
  team: string
  slateId: string
  editable: boolean
  updatedAt?: string
  autoAssigned: boolean
}

interface Props {
  slateId: string
  gameRows: GameRow[]
  usedTeams: string[]
  usedList: { team: string; date: string }[]
  savedPicks: SavedPick[]
  requiredPicks: number
  sharedRound: boolean
  locked: boolean
  teamBrands: TeamBrandDirectory
  serverNow: string
  dayLabel: string
  dateLabel: string
  titleLabel: string
  tagName: string
}

// Pick states: Selected (chosen here, not saved), Submitted (saved, can still
// change until lock), Locked (after first tip). The server enforces every rule
// again on save; this form only presents them.
export default function PickForm({
  slateId,
  gameRows,
  usedList,
  savedPicks: initialPicks,
  requiredPicks,
  sharedRound,
  locked: serverLocked,
  serverNow,
  teamBrands,
  dayLabel,
  dateLabel,
  titleLabel,
  tagName,
}: Props) {
  const router = useRouter()
  const [clockLocked, setClockLocked] = useState(false)
  const locked = serverLocked || clockLocked
  const pending = useRef(false)
  const grid = useRef<HTMLDivElement>(null)
  const [picks, setPicks] = useState(initialPicks)
  const [selected, setSelected] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const name = (team: string) => brandFor(team, teamBrands).shortName
  const deadline = gameRows[0]?.deadline ?? null
  const lockText = tipTime(deadline)
  const savedTeams = useMemo(() => new Set(picks.map((pick) => pick.team)), [picks])
  const editingPick = picks.find((pick) => pick.id === editingId) ?? null
  const canAdd = picks.length < requiredPicks
  const actionAvailable = !locked && (canAdd || picks.some((pick) => pick.editable))
  const games = useMemo(
    () => gameRows.slice().sort((a, b) => Number(a.timeTbd) - Number(b.timeTbd) || new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()),
    [gameRows]
  )
  const teams = games.flatMap((game) => [game.away, game.home])
  const available = teams.filter((side) => !side.used)

  useEffect(() => {
    const receivedAt = Date.now()
    const check = () => {
      const deadline = gameRows[0]?.deadline
      if (deadline && new Date(serverNow).getTime() + Date.now() - receivedAt >= new Date(deadline).getTime()) setClockLocked(true)
    }
    check()
    const clock = window.setInterval(check, 1000)
    const refresh = window.setInterval(() => router.refresh(), 30_000)
    return () => { window.clearInterval(clock); window.clearInterval(refresh) }
  }, [gameRows, router, serverNow])

  // The pick a new selection replaces: the one being changed, or the only
  // editable one when every slot is already filled.
  function targetPick(): SavedPick | null {
    if (editingPick) return editingPick
    if (canAdd) return null
    const editable = picks.filter((pick) => pick.editable)
    return editable.length === 1 ? editable[0] : null
  }

  function chooseTeam(team: string) {
    if (!actionAvailable || submitting) return
    const target = targetPick()
    if (!target && !canAdd) {
      setError('Choose Change next to the pick you want to replace.')
      return
    }
    if (target && !editingId) setEditingId(target.id)
    if (savedTeams.has(team)) {
      // Choosing the team that is already saved just cancels the change.
      if (target?.team === team) setSelected(null)
      return
    }
    setSelected(team)
    setError('')
  }

  function startChange(pick?: SavedPick) {
    const target = pick ?? targetPick()
    if (!target || locked || !target.editable) return
    setEditingId(target.id)
    setSelected(null)
    setError('')
    grid.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    grid.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  async function submit() {
    if (!selected || pending.current || locked) return
    pending.current = true
    setSubmitting(true)
    setError('')
    const target = targetPick()
    try {
      const response = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: slateId, team: selected, pick_id: target?.id ?? null, expected_version: target?.updatedAt }),
      })
      const result = await response.json()
      if (!response.ok) {
        setError(result.error || 'Could not save your pick. Try again.')
        router.refresh()
        return
      }
      const saved = result.pick as { id: string; team: string; slate_id: string; updated_at: string }
      setPicks((current) => {
        const next: SavedPick = {
          id: saved.id,
          team: saved.team,
          slateId: saved.slate_id,
          editable: true,
          autoAssigned: false,
          updatedAt: saved.updated_at,
        }
        return target ? current.map((pick) => (pick.id === target.id ? next : pick)) : [...current, next]
      })
      setSelected(null)
      setEditingId(null)
      router.refresh()
    } catch {
      setError('Could not save your pick. Check your connection and try again.')
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  const target = targetPick()
  const replacing = selected ? target : null
  const slotIndex = target ? picks.findIndex((pick) => pick.id === target.id) : picks.length
  const shownTeam = selected ?? target?.team ?? (requiredPicks === 1 ? picks[0]?.team : null) ?? null
  const shownPick = !selected ? picks.find((pick) => pick.team === shownTeam) ?? null : null
  const submittedView = !!shownPick && !selected
  const gameOf = (team: string | null) => games.find((game) => game.away.team === team || game.home.team === team)
  const shownGame = gameOf(shownTeam)
  const opponent = shownGame ? (shownGame.away.team === shownTeam ? shownGame.home.team : shownGame.away.team) : null
  const cardLabel = requiredPicks > 1 ? `${dayLabel} · pick ${Math.min(slotIndex, requiredPicks - 1) + 1} of ${requiredPicks}` : `${dayLabel} pick`
  const steps = [
    { label: 'Selected', on: !!shownTeam },
    { label: 'Submitted', on: submittedView },
    { label: `Locked at ${lockText}`, on: locked && submittedView },
  ]
  const message = locked
    ? picks.length
      ? shownPick?.autoAssigned ? `Auto-assigned at ${lockText}.` : `Locked at ${lockText}.`
      : 'Locked. No pick was submitted.'
    : selected
      ? 'Selected, not submitted yet.'
      : submittedView
        ? `Submitted. You can change it until ${lockText}.`
        : `Choose a team. Picks lock at ${lockText}.`
  const messageTone = !locked && selected ? s.amber : !submittedView && !locked ? s.gray : undefined
  const dockState = locked
    ? { text: 'Locked', tone: s.gray }
    : selected
      ? { text: 'Selected, not submitted', tone: s.amber }
      : submittedView
        ? { text: 'Submitted', tone: s.green }
        : { text: 'No team selected', tone: s.gray }

  function sideState(side: GameSide, game: GameRow): { state?: string; note: string } {
    if (side.used) return { state: 'used', note: `Used${side.usedOn ? ` ${side.usedOn}` : ''}` }
    if (selected === side.team) return { state: 'selected', note: 'Selected' }
    if (savedTeams.has(side.team)) {
      const being = replacing?.team === side.team
      const index = picks.findIndex((pick) => pick.team === side.team)
      if (!being) return { state: 'submitted', note: locked ? 'Locked' : requiredPicks > 1 ? `Pick ${index + 1}` : 'Submitted' }
    }
    if (locked || game.locked) return { state: 'locked', note: '' }
    return { note: '' }
  }

  const primary = locked ? (
    <Link className={`${s.cta} ${s.ctaQuiet}`} href="/sweat">Open sweat board</Link>
  ) : selected ? (
    <button type="button" className={s.cta} onClick={submit} disabled={submitting}>
      {submitting ? 'Saving…' : `Submit ${name(selected)}`}
    </button>
  ) : submittedView && shownPick?.editable ? (
    <button type="button" className={`${s.cta} ${s.ctaQuiet}`} onClick={() => startChange(shownPick)}>Change pick</button>
  ) : (
    <button type="button" className={s.cta} disabled>Choose a team</button>
  )

  return (
    <div className={s.withDock}>
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}>{dateLabel} · {titleLabel}</div>
          <h1 className={s.title}>{locked ? 'Your pick' : 'Make your pick'}</h1>
        </div>
        {deadline && (
          <div className={s.lockBox}>
            <span>Locks at {lockText}</span>
            <LockCountdown deadline={deadline} className={s.lockClock} soonClassName={s.clockSoon} />
          </div>
        )}
      </div>
      <p className={s.availLine}><b>{available.length}</b> of {teams.length} teams available{sharedRound ? ` · ${requiredPicks} picks this round` : ''}</p>
      <div className={s.mobileLock}>
        <span>{available.length} of {teams.length} teams available</span>
        {deadline && <span>Locks {lockText} · <b><LockCountdown deadline={deadline} /></b></span>}
      </div>
      {error && <p role="alert" className={s.alert}>{error}</p>}

      <div className={s.split} style={{ marginTop: 24 }}>
        <section aria-label="Today's games" ref={grid}>
          <div className={s.sectionHead}><h2>Today’s games</h2><span>{games.length} games · {tagName} shown</span></div>
          <div className={s.pickGrid} role="radiogroup" aria-label="Today's teams">
            {games.map((game) => (
              <div className={s.pickGame} key={game.gameId}>
                <div className={s.pickMeta}>
                  <span><b>{game.timeTbd ? 'TBD' : tipTime(game.kickoff)}</b>{game.tv ? ` · ${game.tv}` : ''}</span>
                  <span>{game.group ?? ''}</span>
                </div>
                {[game.away, game.home].map((side) => {
                  const { state, note } = sideState(side, game)
                  const disabled = side.used || game.locked || locked || submitting || !actionAvailable || (state === 'submitted')
                  return (
                    <button
                      key={side.team}
                      type="button"
                      role="radio"
                      aria-checked={selected === side.team || state === 'submitted'}
                      className={s.teamBtn}
                      data-state={state}
                      disabled={disabled}
                      onClick={() => chooseTeam(side.team)}
                    >
                      <span className={s.teamTag}>{side.seed ?? ''}</span>
                      <span className={s.teamName}>{name(side.team)}</span>
                      <span className={s.teamNote}>{note}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          {games.length === 0 && <p className={s.empty}>No games on this pick day yet.</p>}
        </section>

        <aside className={s.aside} aria-label="Your pick">
          <div className={s.pickPanel}>
            <div className={s.asideHead}><h2>Your pick</h2><span className={s.green}>Alive</span></div>
            {requiredPicks > 1 && (
              <div className={s.slots}>
                {Array.from({ length: requiredPicks }, (_, index) => {
                  const pick = picks[index]
                  return (
                    <div className={s.slot} key={pick?.id ?? `open-${index}`} data-active={!locked && index === slotIndex}>
                      <span className={s.gray}>Pick {index + 1}</span>
                      <b>{pick ? name(pick.team) : locked ? 'Auto-pick pending' : 'Open'}</b>
                      {pick?.autoAssigned && <span className={s.amber}>Auto</span>}
                      {pick?.editable && !locked && (
                        <button type="button" className={s.linkButton} onClick={() => startChange(pick)} aria-pressed={editingId === pick.id}>
                          {editingId === pick.id ? 'Changing' : 'Change'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className={s.pickCard} data-submitted={submittedView}>
              <div className={s.cardLabel}>{cardLabel}</div>
              <div className={s.cardTeam}>{shownTeam ? name(shownTeam) : 'No team selected'}</div>
              {shownGame && opponent && (
                <div className={s.pickLine}>vs {name(opponent)} · {shownGame.timeTbd ? 'TBD' : tipTime(shownGame.kickoff)}{shownGame.tv ? ` · ${shownGame.tv}` : ''}</div>
              )}
              <div className={s.steps}>
                {steps.map((step) => <span className={s.step} data-on={step.on} key={step.label}>{step.label}</span>)}
              </div>
              <div className={`${s.pickMsg} ${messageTone ?? ''}`} aria-live="polite">{message}</div>
            </div>
            {primary}
          </div>

          {usedList.length > 0 && (
            <div className={s.sub}>
              <h3>Already used</h3>
              {usedList.map((row) => (
                <div className={s.usedRow} key={row.team}><span>{name(row.team)}</span><span>{row.date}</span></div>
              ))}
            </div>
          )}
          <div className={s.sub}>
            <h3>Available today</h3>
            <p className={s.availList}>{available.length ? available.map((side) => name(side.team)).join(', ') : 'None'}</p>
          </div>
        </aside>
      </div>

      <div className={s.dock}>
        <span>
          <small className={dockState.tone}>{dockState.text}</small>
          <b>{shownTeam ? name(shownTeam) : 'Choose a team'}</b>
        </span>
        {locked ? (
          <Link className={`${s.cta} ${s.ctaQuiet}`} href="/sweat">Sweat board</Link>
        ) : selected ? (
          <button type="button" className={s.cta} onClick={submit} disabled={submitting}>{submitting ? 'Saving…' : 'Submit'}</button>
        ) : submittedView && shownPick?.editable ? (
          <button type="button" className={`${s.cta} ${s.ctaQuiet}`} onClick={() => startChange(shownPick)}>Change</button>
        ) : null}
      </div>
    </div>
  )
}
