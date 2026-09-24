'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { roundDisplay } from '@/lib/competition'
import { Logo, Arrow, Ball } from '@/app/components/Sports'
import s from '@/app/components/sports.module.css'

export interface GameSide {
  team: string
  used: boolean
  usedOn: string | null
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
  autoAssigned: boolean
}

interface Props {
  slateId: string
  periodLabel: string
  gameRows: GameRow[]
  usedTeams: string[]
  savedPicks: SavedPick[]
  requiredPicks: number
  sharedRound: boolean
  locked: boolean
  teamBrands: TeamBrandDirectory
}

export default function PickForm({
  slateId,
  periodLabel,
  gameRows,
  usedTeams,
  savedPicks: initialPicks,
  requiredPicks,
  sharedRound,
  locked,
  teamBrands,
}: Props) {
  const router = useRouter()
  const [picks, setPicks] = useState(initialPicks)
  const [selected, setSelected] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All games')

  const name = (team: string) => brandFor(team, teamBrands).shortName
  const selectedRow = gameRows.find((game) => game.home.team === selected || game.away.team === selected)
  const deadline = selectedRow?.deadline ?? gameRows[0]?.deadline
  const selectedTeams = useMemo(() => new Set(picks.map((pick) => pick.team)), [picks])
  const editingPick = picks.find((pick) => pick.id === editingId) ?? null
  const canAdd = picks.length < requiredPicks
  const actionAvailable = !locked && (canAdd || picks.some((pick) => pick.editable))

  // Keep an open pick page current when the selected game becomes final.
  // The server checks the result again before it shows the next game day.
  useEffect(() => {
    if (!locked) return
    const timer = window.setInterval(() => router.refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [locked, router])

  const filters = [
    'All games',
    'Available',
    ...(gameRows.some((game) => game.away.rank || game.home.rank || game.away.seed || game.home.seed)
      ? ['Ranked']
      : []),
    ...(usedTeams.length || picks.length ? ['Used teams'] : []),
  ]

  const shown = (() => {
    const loweredQuery = query.toLowerCase()
    return gameRows
      .filter((game) => {
        const sides = [game.away, game.home]
        const matchesSearch = sides.some((side) =>
          `${name(side.team)} ${side.team}`.toLowerCase().includes(loweredQuery)
        )
        if (!matchesSearch) return false
        if (filter === 'Available') {
          return !game.locked && sides.some((side) => !side.used && !selectedTeams.has(side.team))
        }
        if (filter === 'Used teams') {
          return sides.some((side) => side.used || selectedTeams.has(side.team))
        }
        if (filter === 'Ranked') {
          return sides.some((side) => side.rank || side.seed)
        }
        return true
      })
      .sort(
        (a, b) =>
          Number(a.timeTbd) - Number(b.timeTbd) ||
          new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()
      )
  })()

  function time(iso: string) {
    return (
      new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' CT'
    )
  }

  function startEdit(pick: SavedPick) {
    if (!pick.editable || submitting) return
    setEditingId(pick.id)
    setSelected(null)
    setConfirmed(false)
    setError('')
  }

  function chooseTeam(team: string) {
    if (!actionAvailable || submitting) return
    let target = editingId
    if (!target && !canAdd) {
      const editable = picks.filter((pick) => pick.editable)
      if (editable.length !== 1) {
        setError('Choose Change next to the pick you want to replace.')
        return
      }
      target = editable[0].id
      setEditingId(target)
    }
    const targetPick = picks.find((pick) => pick.id === target)
    if (selectedTeams.has(team) && targetPick?.team !== team) return
    setSelected(team)
    setConfirmed(false)
    setError('')
  }

  async function submit() {
    if (!selected || !confirmed || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slate_id: slateId, team: selected, pick_id: editingId }),
      })
      const result = await response.json()
      if (!response.ok) {
        setError(result.error || 'Could not save your pick. Try again.')
        return
      }
      const saved = result.pick as { id: string; team: string; slate_id: string }
      setPicks((current) => {
        const next: SavedPick = {
          id: saved.id,
          team: saved.team,
          slateId: saved.slate_id,
          editable: true,
          autoAssigned: false,
        }
        return editingId
          ? current.map((pick) => (pick.id === editingId ? next : pick))
          : [...current, next]
      })
      setSelected(null)
      setEditingId(null)
      setConfirmed(false)
      router.refresh()
    } catch {
      setError('Could not save your pick. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const nextPickNumber = editingPick
    ? Math.max(1, picks.findIndex((pick) => pick.id === editingPick.id) + 1)
    : picks.length + 1
  const heading = sharedRound
    ? `${requiredPicks} picks. Use them across the round.`
    : 'One team. Your daily pick.'
  const helper = locked
    ? picks.length > 0
      ? `This game day is locked. Your ${picks.length === 1 ? 'pick is' : 'picks are'} final. If your team wins, your next pick opens when the game is final.`
      : 'This game day is locked. Check back when results are final.'
    : sharedRound
      ? `Choose ${requiredPicks} different teams before the round ends. You can make both picks on the same game day.`
      : 'Choose one team from the entire slate. A new pick replaces your previous one.'

  return (
    <div className={s.root} style={{ minHeight: 0 }}>
      <div className={s.pageHeading}>
        <div>
          <p className={s.context}>{periodLabel}</p>
          <h1>{heading}</h1>
          <p>{helper}</p>
        </div>
      </div>

      <div className={s.pickProgress} aria-label={`${picks.length} of ${requiredPicks} picks saved`}>
        <div>
          <strong>{sharedRound ? 'Round picks' : 'Your pick'}</strong>
          <span>{picks.length} / {requiredPicks} saved</span>
        </div>
        <div className={s.savedPickList}>
          {picks.map((pick, index) => (
            <div className={s.savedPick} key={pick.id}>
              <Logo team={pick.team} brands={teamBrands} size={30} />
              <span><small>Pick {index + 1}</small><b>{name(pick.team)}</b></span>
              {pick.autoAssigned ? <em>Auto</em> : null}
              {pick.editable ? (
                <button type="button" onClick={() => startEdit(pick)} aria-pressed={editingId === pick.id}>
                  {editingId === pick.id ? 'Changing' : 'Change'}
                </button>
              ) : (
                <em>Locked</em>
              )}
            </div>
          ))}
          {Array.from({ length: Math.max(0, requiredPicks - picks.length) }, (_, index) => (
            <div className={`${s.savedPick} ${s.savedPickEmpty}`} key={`open-${index}`}>
              <span className={s.emptyBall}><Ball /></span>
              <span><small>Pick {picks.length + index + 1}</small><b>Open</b></span>
            </div>
          ))}
        </div>
      </div>

      <div className={s.pickLayout}>
        <section className={s.pickList}>
          <div className={s.pickToolbar}>
            <label className={s.search}>
              <input
                type="search"
                aria-label="Find a team"
                placeholder="Find a team"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span>{shown.length} games · All times CT</span>
          </div>
          <div className={s.pickFilters} aria-label="Filter games">
            {filters.map((item) => (
              <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </div>
          <div aria-label="Teams available to pick" className={s.selectionGames}>
            {shown.map((game) => (
              <article className={s.selectionGame} key={game.gameId}>
                <div className={s.selectionMeta}>
                  <b>{game.timeTbd ? 'Time TBD' : time(game.kickoff)}</b>
                  <span>{game.tv}</span>
                </div>
                {game.round ? <p className={s.venue}>{roundDisplay(game.round)} {game.region}</p> : null}
                {[game.away, game.home].map((side, index) => {
                  const savedHere = selectedTeams.has(side.team)
                  const chosen = selected === side.team
                  const unavailable = side.used || (savedHere && editingPick?.team !== side.team)
                  return (
                    <button
                      key={side.team}
                      type="button"
                      aria-pressed={chosen || savedHere}
                      disabled={game.locked || unavailable || submitting || !actionAvailable}
                      className={`${s.teamOption} ${chosen || savedHere ? s.teamSelected : ''}`}
                      onClick={() => chooseTeam(side.team)}
                    >
                      <Logo team={side.team} brands={teamBrands} size={40} />
                      <span className={s.optionName}>
                        <strong>
                          {side.seed ? `(${side.seed}) ` : side.rank ? `#${side.rank} ` : ''}
                          {name(side.team)}
                        </strong>
                        <small>{side.record}<span>{index === 0 ? 'Away' : 'Home'}</span></small>
                      </span>
                      <span className={s.optionState}>
                        {side.used
                          ? `Used${side.usedOn ? ` · ${side.usedOn}` : ''}`
                          : savedHere
                            ? 'Saved'
                            : game.locked
                              ? 'Locked'
                              : chosen
                                ? `Pick ${nextPickNumber}`
                                : ''}
                      </span>
                      <span className={s.radioMark} aria-hidden="true" />
                    </button>
                  )
                })}
                <p className={s.venue}>{game.venue ?? 'Venue to be announced'}</p>
              </article>
            ))}
          </div>
          {!shown.length ? (
            <div className={s.empty}>
              <h2>No matching games</h2>
              <p>Try another team or filter.</p>
              <button className={s.secondary} onClick={() => { setQuery(''); setFilter('All games') }}>
                Reset filters
              </button>
            </div>
          ) : null}
        </section>

        <aside className={`${s.selectionDesk} ${selected ? s.deskActive : ''}`}>
          <div className={s.deskHeading}>
            <h2>{editingPick ? `Change pick ${nextPickNumber}` : `Pick ${nextPickNumber}`}</h2>
            <span>{picks.length} / {requiredPicks}</span>
          </div>
          <p className={s.deskDate}>{periodLabel}</p>
          <div className={s.selectedTeam} aria-live="polite">
            {selected ? (
              <>
                <Logo team={selected} brands={teamBrands} size={66} />
                <strong>{name(selected)}</strong>
                <span>Ready to confirm</span>
              </>
            ) : (
              <>
                <span className={s.emptyBall}><Ball /></span>
                <strong>{locked ? 'Picks locked.' : canAdd ? 'The choice is yours.' : 'Your picks are saved.'}</strong>
                <span>
                  {locked
                    ? 'This game day has tipped off.'
                    : canAdd
                      ? `Select team ${picks.length + 1} of ${requiredPicks}.`
                      : 'Choose Change to replace an open pick.'}
                </span>
              </>
            )}
          </div>
          <div className={s.deadline}>
            <div>
              <span>All picks for this game day lock at the first tip</span>
              <b>
                {deadline
                  ? new Date(deadline).toLocaleString('en-US', {
                      timeZone: 'America/Chicago',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZoneName: 'short',
                    })
                  : 'Deadline pending'}
              </b>
            </div>
          </div>
          {selected && selected !== editingPick?.team ? (
            <label className={s.confirmation}>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={submitting}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>Confirm {name(selected)} as pick {nextPickNumber} of {requiredPicks}.</span>
            </label>
          ) : null}
          {error ? <p role="alert" className={s.privacyNotice}>{error}</p> : null}
          <button
            className={s.primary}
            disabled={!selected || selected === editingPick?.team || !confirmed || submitting || selectedRow?.locked}
            onClick={submit}
          >
            {submitting ? 'Saving…' : editingPick ? 'Save changed pick' : `Save pick ${nextPickNumber}`}
            <Arrow />
          </button>
          <p className={s.deskNote}>
            {sharedRound
              ? `You need ${requiredPicks} total picks across this round, not one pick each day.`
              : 'You can change your pick until the deadline.'}
          </p>
        </aside>
      </div>
    </div>
  )
}
