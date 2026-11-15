'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { formatClock } from '@/lib/deadline'
import { useViewerTimeZone } from '@/app/components/LocalTime'
import LockCountdown from '@/app/components/LockCountdown'
import TeamLogo from '@/app/components/TeamLogo'
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
  // The next day was opened from ESPN's final before the stored result (REL-03).
  resultPending?: boolean
}

// Messages that must survive the page refresh after a save, a refusal or the
// lock: the form remounts when its saved picks or lock state change, which
// would otherwise wipe what the player was just told (USE-01, USE-03, USE-06).
type Flash = { kind: 'error' | 'ok'; text: string; at: number }
const FLASH_MS = 2 * 60 * 1000
function writeFlash(slateId: string, kind: Flash['kind'], text: string) {
  try { sessionStorage.setItem(`pick-flash:${slateId}`, JSON.stringify({ kind, text, at: Date.now() })) } catch { /* storage unavailable */ }
}
function takeFlash(slateId: string): Flash | null {
  try {
    const raw = sessionStorage.getItem(`pick-flash:${slateId}`)
    sessionStorage.removeItem(`pick-flash:${slateId}`)
    const flash = raw ? (JSON.parse(raw) as Flash) : null
    return flash && Date.now() - flash.at < FLASH_MS ? flash : null
  } catch { return null }
}
// A save that hears nothing back in this long is checked against its receipt.
const SUBMIT_TIMEOUT_MS = 15_000

// Pick states: Selected (chosen here, not saved), Saved (can still
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
  resultPending = false,
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
  const [uncertain,setUncertain]=useState(false)
  const [notice, setNotice] = useState('')
  const [deadlineMoved, setDeadlineMoved] = useState('')
  const requestId=useRef<string | null>(null)

  const name = (team: string) => brandFor(team, teamBrands).shortName
  const deadline = gameRows[0]?.deadline ?? null
  // Viewer-local display (Central until the browser zone is known); the server enforces the lock.
  const viewerZone = useViewerTimeZone()
  const lockText = formatClock(deadline, viewerZone)
  const tipText = (iso: string) => formatClock(iso, viewerZone, false)
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

  // Latest values for the lock timer, which outlives a render.
  const live = useRef({ selected, lockText, name, submitting })
  useEffect(() => { live.current = { selected, lockText, name, submitting } })

  // Restore a message from before the last refresh.
  // Browser storage is read after hydration (the server render has none).
  useEffect(() => {
    const id = window.setTimeout(() => {
      const flash = takeFlash(slateId)
      if (flash?.kind === 'error') setError(flash.text)
      else if (flash) setNotice(flash.text)
    }, 0)
    return () => window.clearTimeout(id)
  }, [slateId])

  // REL-04: the lock only ever moves earlier. Tell the player when it did
  // since they last looked, instead of letting the deadline shrink silently.
  useEffect(() => {
    if (!deadline) return
    const id = window.setTimeout(() => {
      try {
        const key = `pick-deadline:${slateId}`
        const seen = localStorage.getItem(key)
        if (seen && new Date(deadline).getTime() <= new Date(seen).getTime() - 60_000) {
          setDeadlineMoved(`The lock time moved earlier: it was ${formatClock(seen, viewerZone)}, it is now ${formatClock(deadline, viewerZone)}.`)
        }
        localStorage.setItem(key, deadline)
      } catch { /* storage unavailable */ }
    }, 0)
    return () => window.clearTimeout(id)
  }, [deadline, slateId, viewerZone])

  useEffect(() => {
    const receivedAt = Date.now()
    const check = () => {
      const deadline = gameRows[0]?.deadline
      // Server time when it is ahead of this device; never behind it (a stale
      // serverNow must not delay the lock view).
      const nowGuess = Math.max(Date.now(), new Date(serverNow).getTime() + Date.now() - receivedAt)
      if (deadline && nowGuess >= new Date(deadline).getTime()) {
        // USE-01: a selection that was never submitted is not a pick. Say so
        // plainly before the board turns into the locked view.
        const { selected: unsaved, lockText: at, name: label, submitting: saving } = live.current
        if (unsaved && !saving) {
          const text = `Picks locked at ${at} before you submitted. ${label(unsaved)} was not saved.`
          setError(text)
          writeFlash(slateId, 'error', text)
        }
        setClockLocked(true)
      }
    }
    check()
    const clock = window.setInterval(check, 1000)
    const refresh = window.setInterval(() => { if(!document.hidden) router.refresh() }, 30_000 + Math.floor(Math.random()*5000))
    return () => { window.clearInterval(clock); window.clearInterval(refresh) }
  }, [gameRows, router, serverNow, slateId])

  // The pick a new selection replaces: the one being changed, or the only
  // editable one when every slot is already filled.
  function targetPick(): SavedPick | null {
    if (editingPick) return editingPick
    if (canAdd) return null
    const editable = picks.filter((pick) => pick.editable)
    return editable.length === 1 ? editable[0] : null
  }

  function chooseTeam(team: string) {
    if (!actionAvailable || submitting || uncertain) return
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
    requestId.current=null
    setSelected(team)
    setError('')
  }

  function startChange(pick?: SavedPick) {
    const target = pick ?? targetPick()
    if (!target || locked || !target.editable || uncertain) return
    setEditingId(target.id)
    setSelected(null)
    setError('')
    grid.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    grid.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  async function checkReceipt() {
    if(!requestId.current)return
    setUncertain(true)
    try {
      const check=await fetch(`/api/picks?request_id=${requestId.current}&slate_id=${encodeURIComponent(slateId)}&team=${encodeURIComponent(selected??'')}`,{cache:'no-store'})
      if(!check.ok)throw new Error('Reconciliation unavailable')
      const receipt=await check.json()
      if(receipt.found){
        const saved=receipt.pick
        setPicks(current=>{const next={id:saved.id,team:saved.team,slateId:saved.slate_id,editable:!locked,autoAssigned:false,updatedAt:saved.updated_at};return current.some(p=>p.id===saved.id)?current.map(p=>p.id===saved.id?next:p):[...current,next]})
        setSelected(null);setEditingId(null);requestId.current=null;setUncertain(false)
        setError('Your pick was saved. The original response was lost.')
        router.refresh()
      }else setError('No receipt found yet. Check again or retry the same selection using its original request ID.')
    }catch{setError('Outcome still unknown. Check saved pick before making another selection.')}
  }

  async function submit() {
    if (!selected || pending.current || locked) return
    pending.current = true
    setSubmitting(true)
    setError('')
    const target = targetPick()
    requestId.current ??= crypto.randomUUID()
    try {
      const response = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id:requestId.current, slate_id: slateId, team: selected, pick_id: target?.id ?? null, expected_version: target?.updatedAt }),
        // USE-05: a stalled connection must not leave "Saving…" on screen forever.
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      })
      const result = await response.json().catch(() => null) as { error?: string; resultPending?: boolean; pick?: unknown } | null
      if (response.status === 401) {
        requestId.current = null
        setError(`Your session expired. ${name(selected)} was not saved — log in again, then submit your pick.`)
        return
      }
      if (!response.ok && response.status >= 500 || !result) {
        // The server may have saved before failing; the receipt decides.
        setUncertain(true)
        setError('The server did not confirm your pick. Checking whether it was saved…')
        await checkReceipt()
        return
      }
      if (!response.ok) {
        requestId.current=null
        if (result.resultPending) {
          // Keep the selection: the same submission succeeds once the result is stored.
          setError(result.error ?? 'Your result is still being confirmed. Try again in a minute.')
          return
        }
        // USE-03: keep the refusal across the refresh and point at what is saved.
        const text = `${result.error || 'Pick rejected.'} ${name(selected)} was not saved${picks.length ? ' — your saved pick is shown below.' : '.'}`
        setError(text)
        writeFlash(slateId, 'error', text)
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
      setUncertain(false)
      requestId.current=null
      setSelected(null)
      setEditingId(null)
      // USE-06: confirm what was saved, when, and until when it can change.
      const savedText = `Saved: ${name(saved.team)} at ${formatClock(saved.updated_at ?? new Date().toISOString(), viewerZone)}${deadline ? ` · you can change it until ${lockText}` : ''}.`
      setNotice(savedText)
      writeFlash(slateId, 'ok', savedText)
      router.refresh()
    } catch {
      setUncertain(true)
      setError('Connection interrupted. Checking whether the server accepted your pick…')
      await checkReceipt()
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  const target = targetPick()
  const activeSelection = locked ? null : selected
  const replacing = activeSelection ? target : null
  const slotIndex = target ? picks.findIndex((pick) => pick.id === target.id) : picks.length
  const shownTeam = activeSelection ?? target?.team ?? (requiredPicks === 1 ? picks[0]?.team : null) ?? null
  const shownPick = !activeSelection ? picks.find((pick) => pick.team === shownTeam) ?? null : null
  const submittedView = !!shownPick
  const gameOf = (team: string | null) => games.find((game) => game.away.team === team || game.home.team === team)
  const shownGame = gameOf(shownTeam)
  const opponent = shownGame ? (shownGame.away.team === shownTeam ? shownGame.home.team : shownGame.away.team) : null
  const cardLabel = requiredPicks > 1 ? `${dayLabel} · pick ${Math.min(slotIndex, requiredPicks - 1) + 1} of ${requiredPicks}` : `${dayLabel} pick`
  const pickStatus = locked
    ? !picks.length ? 'No pick at lock' : shownPick?.autoAssigned ? 'Auto-assigned at lock' : 'Locked'
    : activeSelection
      ? 'Selected'
      : submittedView
        ? 'Pick saved'
        : picks.length ? `${picks.length} of ${requiredPicks} picks saved` : 'No team selected'
  const teamName = shownTeam ? name(shownTeam) : null
  const receipt = !teamName
    ? pickStatus
    : activeSelection || pickStatus === 'Locked'
      ? `${teamName} ${pickStatus.toLowerCase()}`
      : `${pickStatus}: ${teamName}`
  const changeDeadline = !locked && deadline && shownPick?.editable ? `Change until ${lockText}` : null

  function sideState(side: GameSide, game: GameRow): { state?: string; note: string } {
    if (side.used) return { state: 'used', note: `Used${side.usedOn ? ` ${side.usedOn}` : ''}` }
    if (activeSelection === side.team) return { state: 'selected', note: '' }
    if (savedTeams.has(side.team)) {
      const being = replacing?.team === side.team
      const index = picks.findIndex((pick) => pick.team === side.team)
      if (!being) return { state: 'submitted', note: requiredPicks > 1 ? `Pick ${index + 1}` : '' }
    }
    if (locked || game.locked) return { state: 'locked', note: '' }
    return { note: '' }
  }

  // Action names match the rest of the site: "Make your pick" opens this
  // page, "Choose a team" is the instruction here, "Submit pick" saves it.
  const primary = locked ? (
    <Link className={`${s.cta} ${s.ctaQuiet}`} href="/sweat">View picks</Link>
  ) : selected ? (
    <button type="button" className={s.cta} onClick={submit} disabled={submitting || uncertain}>
      {submitting ? 'Saving…' : 'Submit pick'}
    </button>
  ) : submittedView && shownPick?.editable ? (
    <button type="button" className={`${s.cta} ${s.ctaQuiet}`} onClick={() => startChange(shownPick)}>Change pick</button>
  ) : (
    <>
      <button type="button" className={s.cta} disabled aria-describedby="submit-hint">Submit pick</button>
      <p id="submit-hint" className={s.ctaHint}>Choose a team from today’s games to submit.</p>
    </>
  )

  return (
    <div className={s.withDock}>
      <div className="sr-only" role="status">{receipt}</div>
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}>{dateLabel} · {titleLabel}</div>
          <h1 className={s.title}>{locked ? 'Your pick' : 'Choose a team'}</h1>
        </div>
        {deadline && (
          <div className={s.lockBox}>
            <span>Locks at {lockText}</span>
            <LockCountdown deadline={deadline} serverNow={serverNow} className={s.lockClock} soonClassName={s.clockSoon} />
          </div>
        )}
      </div>
      <p className={s.availLine}><b>{available.length}</b> of {teams.length} teams available{sharedRound ? ` · ${requiredPicks} picks this round` : ''}</p>
      <div className={s.mobileLock}>
        <span>{available.length} of {teams.length} teams available</span>
        {deadline && <span>Locks {lockText} · <b><LockCountdown deadline={deadline} serverNow={serverNow} /></b></span>}
      </div>
      {deadlineMoved && !locked && <p role="alert" className={s.alert}>{deadlineMoved}</p>}
      {resultPending && !locked && <p className={s.notice}>Your win is final on the live scoreboard and is being confirmed. You can choose now; saving opens within a minute or two.</p>}
      {error && <p role="alert" className={s.alert}>{error}</p>}
      {notice && !error && <p role="status" className={s.notice}>{notice}</p>}
      {uncertain && <div><button className={s.cta} onClick={()=>void checkReceipt()} disabled={submitting}>Check saved pick</button>{!locked&&<button className={s.cta} onClick={()=>void submit()} disabled={submitting}>Retry same selection</button>}</div>}

      <div className={s.split} style={{ marginTop: 24 }}>
        <section aria-label="Today's games" ref={grid}>
          <div className={s.sectionHead}><h2>Today’s games</h2><span>{games.length} games · {tagName} shown</span></div>
          <div className={s.pickGrid} role="radiogroup" aria-label="Today's teams">
            {games.map((game) => (
              <div className={s.pickGame} key={game.gameId}>
                <div className={s.pickMeta}>
                  <span><b>{game.timeTbd ? 'TBD' : tipText(game.kickoff)}</b>{game.tv ? ` · ${game.tv}` : ''}</span>
                  <span>{game.group ?? ''}</span>
                </div>
                {[game.away, game.home].map((side) => {
                  const { state, note } = sideState(side, game)
                  const disabled = uncertain || side.used || game.locked || locked || submitting || !actionAvailable || (state === 'submitted')
                  return (
                    <button
                      key={side.team}
                      type="button"
                      role="radio"
                      aria-checked={activeSelection === side.team || state === 'submitted'}
                      className={s.teamBtn}
                      data-state={state}
                      disabled={disabled}
                      onClick={() => chooseTeam(side.team)}
                    >
                      <span className={s.teamTag}>{side.seed ?? ''}</span>
                      <TeamLogo team={side.team} brands={teamBrands} size={26} />
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
              <div className={s.cardTeamRow}>
                {shownTeam && <TeamLogo team={shownTeam} brands={teamBrands} size={38} />}
                <div className={s.cardTeam}>{receipt}</div>
              </div>
              {shownGame && opponent && (
                <div className={s.pickLine}>vs {name(opponent)} · {shownGame.timeTbd ? 'TBD' : tipText(shownGame.kickoff)}{shownGame.tv ? ` · ${shownGame.tv}` : ''}</div>
              )}
              {changeDeadline && <div className={s.pickLine}>{changeDeadline}</div>}
            </div>
            {primary}
          </div>

          {usedList.length > 0 && (
            <div className={s.sub}>
              <h3>Already used</h3>
              {usedList.map((row) => (
                <div className={s.usedRow} key={row.team}><span className={s.teamLine}><TeamLogo team={row.team} brands={teamBrands} size={18} /><span>{name(row.team)}</span></span><span>{row.date}</span></div>
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
          {teamName && <small className={activeSelection ? s.amber : s.gray}>{pickStatus}</small>}
          <b>{teamName ?? pickStatus}</b>
        </span>
        {locked ? (
          <Link className={`${s.cta} ${s.ctaQuiet}`} href="/sweat">View picks</Link>
        ) : selected ? (
          <button type="button" className={s.cta} onClick={submit} disabled={submitting || uncertain}>{submitting ? 'Saving…' : 'Submit pick'}</button>
        ) : submittedView && shownPick?.editable ? (
          <button type="button" className={`${s.cta} ${s.ctaQuiet}`} onClick={() => startChange(shownPick)}>Change pick</button>
        ) : null}
      </div>
    </div>
  )
}
