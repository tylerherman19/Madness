'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { AliveRow, OutRow } from '@/lib/standingsRows'
import { unpackAlive, unpackOut, type PackedAlive, type PackedOut } from '@/lib/standingsWire'
import {
  INITIAL_ROWS,
  ROWS_STEP,
  filterByName,
  groupedItems,
  plainItems,
  sortAlive,
  sortOut,
  windowItems,
  type ListItem,
  type SortMode,
} from '@/lib/standingsList'
import { formatClock } from '@/lib/deadline'
import { useViewerTimeZone } from './LocalTime'
import type { TeamBrand } from '@/lib/teamBrand'
import TeamLogo from './TeamLogo'
import s from './pp.module.css'

interface Group<T> {
  key: string
  team: string | null // abbreviation, when the group is a team
  label: string
  tone?: string
  rows: T[]
}

export default function StandingsTable({
  alive: packedAlive,
  out: packedOut,
  outLabels,
  teamBrands,
  dayLabel,
  hiddenUntil: hiddenUntilIso,
  showSeedTotal = false,
  signupsClosed = true,
  compact = false,
}: {
  alive: PackedAlive[]
  out: PackedOut[]
  outLabels: Record<number, string>
  teamBrands: Record<string, TeamBrand>
  dayLabel: string
  // The instant picks are revealed (the slate's lock), shown in the viewer's time zone.
  hiddenUntil: string | null
  showSeedTotal?: boolean
  signupsClosed?: boolean
  // The Today page's side column: one status column, no search.
  compact?: boolean
}) {
  const [sort, setSort] = useState<SortMode>('alphabetical')
  const [query, setQuery] = useState('')
  const name = (team: string) => teamBrands[team]?.shortName ?? team
  // Rows arrive packed (lib/standingsWire.ts); search, sort and the window all
  // run over every entry once they are expanded.
  const alive = useMemo(() => unpackAlive(packedAlive), [packedAlive])
  const out = useMemo(() => unpackOut(packedOut, outLabels, (team) => teamBrands[team]?.shortName ?? team), [packedOut, outLabels, teamBrands])
  const teamsText = (teams: string[]) => teams.map(name).join(', ')

  const viewerZone = useViewerTimeZone()
  const hiddenUntil = hiddenUntilIso ? formatClock(hiddenUntilIso, viewerZone) : null

  // Order once per sort mode, then search the whole ordered list per keystroke;
  // only the rendered slice is windowed (below), never the data searched.
  const sortedAlive = useMemo(() => sortAlive(alive, sort), [alive, sort])
  const sortedOut = useMemo(() => sortOut(out, sort), [out, sort])
  const aliveRows = useMemo(() => filterByName(sortedAlive, query), [sortedAlive, query])
  const outRows = useMemo(() => filterByName(sortedOut, query), [sortedOut, query])

  // How many entries each list shows. A new search or sort starts over at the
  // first page, derived from the key so no effect has to reset it.
  const limitKey = `${sort}\u0000${query.trim().toLowerCase()}`
  const [limits, setLimits] = useState({ key: limitKey, alive: INITIAL_ROWS, out: INITIAL_ROWS })
  // Any sort or search change starts over at the first page (stored, so a
  // later return to an earlier search does not bring back an enlarged window).
  if (limits.key !== limitKey) setLimits({ key: limitKey, alive: INITIAL_ROWS, out: INITIAL_ROWS })
  const aliveLimit = limits.key === limitKey ? limits.alive : INITIAL_ROWS
  const outLimit = limits.key === limitKey ? limits.out : INITIAL_ROWS
  // After "Show more", focus moves to the first new row so keyboard and
  // screen-reader position is kept where the list grew.
  const focusRow = useRef<{ list: 'alive' | 'out'; index: number } | null>(null)
  const aliveTable = useRef<HTMLDivElement>(null)
  const outTable = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const pending = focusRow.current
    if (!pending) return
    focusRow.current = null
    const table = pending.list === 'alive' ? aliveTable.current : outTable.current
    table?.querySelector<HTMLElement>(`[aria-rowindex="${pending.index}"]`)?.focus()
  })

  // "By team": one group per team, biggest first. Before lock other entries'
  // teams are hidden, so they group by status instead.
  function groupAlive(rows: AliveRow[]): Group<AliveRow>[] {
    const groups = new Map<string, Group<AliveRow>>()
    for (const row of rows) {
      const visible = row.teams.length > 0 && (row.status === 'picked' || row.me)
      const key = visible ? row.teams.join('+') : row.status === 'none' ? '~none' : '~locked'
      if (!groups.has(key)) {
        groups.set(key, visible
          ? { key, team: row.teams[0], label: teamsText(row.teams), rows: [] }
          : key === '~none'
            ? { key, team: null, label: 'No pick yet', tone: s.gray, rows: [] }
            : { key, team: null, label: hiddenUntil ? `Locked in · hidden until ${hiddenUntil}` : 'Locked in', tone: s.gray, rows: [] })
      }
      groups.get(key)!.rows.push(row)
    }
    return [...groups.values()].sort((a, b) => Number(a.key.startsWith('~')) - Number(b.key.startsWith('~')) || b.rows.length - a.rows.length || a.label.localeCompare(b.label))
  }
  function groupOut(rows: OutRow[]): Group<OutRow>[] {
    const groups = new Map<string, Group<OutRow>>()
    for (const row of rows) {
      const key = row.teams.length ? row.teams.join('+') : '~none'
      if (!groups.has(key)) groups.set(key, { key, team: row.teams[0] ?? null, label: row.teams.length ? teamsText(row.teams) : 'No pick', rows: [] })
      groups.get(key)!.rows.push(row)
    }
    return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label))
  }

  const status = (row: AliveRow) =>
    // Neutral unless it's your own missing pick, the one thing to act on.
    row.status === 'locked' || row.status === 'picked' ? { text: 'Locked in', tone: s.gray }
      : row.status === 'submitted' ? { text: 'Submitted', tone: s.gray }
        : row.me ? { text: 'Not submitted', tone: s.amber } : { text: 'No pick yet', tone: s.gray }

  const sorts: [SortMode, string][] = [['alphabetical', 'Alphabetical'], ['team', 'By team'], ...(showSeedTotal && !compact ? [['seeds', 'Seed total'] as [SortMode, string]] : [])]

  // Each rendered row carries its position in the FULL list (aria-rowindex), so
  // assistive tech reports "row 412 of 1,000" even though only a slice is in the DOM.
  const rowProps = (index: number) => ({ role: 'row', 'aria-rowindex': index, tabIndex: -1 }) as const

  const aliveRow = (row: AliveRow, grouped: boolean, index: number) => {
    const st = status(row)
    const pick = row.teams.length ? (
      <span className={s.teamLine} role="cell">
        <TeamLogo team={row.teams[0]} brands={teamBrands} size={18} />
        <span>{teamsText(row.teams)}{row.me && row.status === 'submitted' ? ' (submitted)' : ''}</span>
      </span>
    ) : row.status === 'locked' && hiddenUntil ? <span className={s.hidden} role="cell">Hidden until {hiddenUntil}</span> : <span role="cell" />
    if (compact) {
      return (
        <div className={s.stRow} data-me={row.me} key={row.id} {...rowProps(index)}>
          <span role="cell">{row.me ? 'You' : row.name}</span>
          {grouped ? <span role="cell" /> : row.teams.length ? pick : <span className={st.tone} role="cell">{st.text}</span>}
        </div>
      )
    }
    return (
      <div className={s.stRow} data-me={row.me} key={row.id} {...rowProps(index)}>
        <span role="cell">{row.me ? 'You' : row.name}</span>
        <span className={st.tone} role="cell">{st.text}</span>
        {sort === 'seeds' ? <span role="cell">{row.seedTotal}</span> : grouped ? <span role="cell" /> : pick}
      </div>
    )
  }

  const outRow = (row: OutRow, grouped: boolean, index: number) => (
    <div className={`${s.stRow} ${s.stOut}`} key={row.id} {...rowProps(index)}>
      <span role="cell">{row.name}</span>
      {compact ? (
        <span className={grouped ? undefined : s.red} role="cell">{grouped ? row.out : row.teams.length ? `${row.out} · ${teamsText(row.teams)}` : row.out}</span>
      ) : (
        <>
          <span role="cell">{row.out}</span>
          {sort === 'seeds' ? <span role="cell">{row.seedTotal}</span> : <span className={s.red} role="cell">{grouped ? '' : row.losing ?? 'Out'}</span>}
        </>
      )}
    </div>
  )

  const groupHead = (group: Group<AliveRow | OutRow>, index: number) => (
    <div className={s.teamGroup} key={`h-${group.key}`} {...rowProps(index)}>
      {group.team ? <TeamLogo team={group.team} brands={teamBrands} size={22} /> : null}
      <b className={group.tone} role="rowheader">{group.label}</b>
      <span role="cell">{group.rows.length}</span>
    </div>
  )

  if (alive.length === 0 && out.length === 0) {
    return (
      <div className={s.stSection}>
        <p className={s.empty}>Entries appear here when players join.</p>
        {!signupsClosed && <Link className={s.cta} href="/signup" style={{ width: 220 }}>Join the pool</Link>}
      </div>
    )
  }

  const grouped = sort === 'team'
  // The header row is row 1 of each table; compact tables have none.
  const headerRows = compact ? 0 : 1
  const aliveItems: ListItem<Group<AliveRow>, AliveRow>[] = grouped ? groupedItems(groupAlive(aliveRows)) : plainItems(aliveRows)
  const outItems: ListItem<Group<OutRow>, OutRow>[] = grouped ? groupedItems(groupOut(outRows)) : plainItems(outRows)
  const aliveWindow = windowItems(aliveItems, aliveLimit, (row) => row.me)
  const outWindow = windowItems(outItems, outLimit, (row) => row.me)

  function showMore(list: 'alive' | 'out') {
    const shown = (list === 'alive' ? aliveWindow : outWindow).shown.length
    focusRow.current = { list, index: shown + 1 + headerRows }
    setLimits({
      key: limitKey,
      alive: list === 'alive' ? aliveLimit + ROWS_STEP : aliveLimit,
      out: list === 'out' ? outLimit + ROWS_STEP : outLimit,
    })
  }

  const showMoreButton = (list: 'alive' | 'out', window: { rowsShown: number; rowsTotal: number }, label: string) => {
    const remaining = window.rowsTotal - window.rowsShown
    if (remaining <= 0) return null
    const next = Math.min(ROWS_STEP, remaining)
    return (
      <button type="button" className={s.showMore} onClick={() => showMore(list)}>
        Show {next} more {label}
        <span> · {window.rowsShown} of {window.rowsTotal} shown</span>
      </button>
    )
  }

  const searching = query.trim() !== ''
  const announcement = searching
    ? `${aliveRows.length} of ${alive.length} alive and ${outRows.length} of ${out.length} eliminated entries match.`
    : ''
  // aria-sort only claims an order that is strictly true: your own entry is
  // pinned first among the alive entries, which makes that list "other".
  const aliveHasMe = aliveRows.some((row) => row.me)
  const aliveSortAttr = (column: 'entry' | 'seed') =>
    column === 'entry' && sort === 'alphabetical' ? (aliveHasMe ? 'other' : 'ascending')
      : column === 'seed' && sort === 'seeds' ? (aliveWindow.pinned ? 'other' : 'descending') : undefined
  const outSortAttr = (column: 'entry' | 'seed') =>
    column === 'entry' && sort === 'alphabetical' ? (outWindow.pinned ? 'other' : 'ascending')
      : column === 'seed' && sort === 'seeds' ? (outWindow.pinned ? 'other' : 'descending') : undefined

  return (
    <div className={compact ? s.stCompact : undefined}>
      <div className={s.toolbar}>
        <div className={s.tabs} role="tablist" aria-label="Sort">
          {sorts.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={sort === key} onClick={() => setSort(key)}>{label}</button>
          ))}
        </div>
        {!compact && (
          <label className={s.search}>
            <span>Find an entry</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name" />
          </label>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

      <section className={s.stSection} aria-label="Still alive">
        <div className={s.stHead}><b>{alive.length}</b><span>still alive</span></div>
        <div ref={aliveTable} role="table" aria-label="Entries still alive" aria-rowcount={aliveItems.length + headerRows}>
          {!compact && (
            <div className={`${s.stRow} ${s.stLabels}`} role="row" aria-rowindex={1}>
              <span role="columnheader" aria-sort={aliveSortAttr('entry')}>Entry</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" aria-sort={aliveSortAttr('seed')}>{sort === 'seeds' ? 'Seed total' : `${dayLabel} pick`}</span>
            </div>
          )}
          {aliveWindow.pinned && aliveRow(aliveWindow.pinned.row, false, aliveWindow.pinned.position + headerRows)}
          {aliveWindow.shown.map((item, i) =>
            item.type === 'head' ? groupHead(item.group, i + 1 + headerRows) : aliveRow(item.row, grouped, i + 1 + headerRows)
          )}
        </div>
        {aliveRows.length === 0 && <p className={s.empty}>No match.</p>}
        {showMoreButton('alive', aliveWindow, 'alive entries')}
      </section>

      {out.length > 0 && (
        <section className={s.stSection} aria-label="Eliminated">
          <div className={s.stHead}><b>{out.length}</b><span>eliminated</span></div>
          <div ref={outTable} role="table" aria-label="Eliminated entries" aria-rowcount={outItems.length + headerRows}>
            {!compact && (
              <div className={`${s.stRow} ${s.stLabels}`} role="row" aria-rowindex={1}>
                <span role="columnheader" aria-sort={outSortAttr('entry')}>Entry</span>
                <span role="columnheader">Out</span>
                <span role="columnheader" aria-sort={outSortAttr('seed')}>{sort === 'seeds' ? 'Seed total' : 'Losing pick'}</span>
              </div>
            )}
            {outWindow.pinned && outRow(outWindow.pinned.row, false, outWindow.pinned.position + headerRows)}
            {outWindow.shown.map((item, i) =>
              item.type === 'head' ? groupHead({ ...item.group, tone: s.red }, i + 1 + headerRows) : outRow(item.row, grouped, i + 1 + headerRows)
            )}
          </div>
          {outRows.length === 0 && <p className={s.empty}>No match.</p>}
          {showMoreButton('out', outWindow, 'eliminated entries')}
        </section>
      )}
    </div>
  )
}
