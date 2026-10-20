'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { AliveRow, OutRow } from '@/lib/standingsRows'
import type { TeamBrand } from '@/lib/teamBrand'
import TeamLogo from './TeamLogo'
import s from './pp.module.css'

type SortMode = 'alphabetical' | 'team' | 'seeds'

interface Group<T> {
  key: string
  team: string | null // abbreviation, when the group is a team
  label: string
  tone?: string
  rows: T[]
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export default function StandingsTable({
  alive,
  out,
  teamBrands,
  dayLabel,
  hiddenUntil,
  showSeedTotal = false,
  signupsClosed = true,
  compact = false,
}: {
  alive: AliveRow[]
  out: OutRow[]
  teamBrands: Record<string, TeamBrand>
  dayLabel: string
  hiddenUntil: string | null
  showSeedTotal?: boolean
  signupsClosed?: boolean
  // The Today page's side column: one status column, no search.
  compact?: boolean
}) {
  const [sort, setSort] = useState<SortMode>('alphabetical')
  const [query, setQuery] = useState('')
  const name = (team: string) => teamBrands[team]?.shortName ?? team
  const teamsText = (teams: string[]) => teams.map(name).join(', ')

  const match = (row: { name: string }) => row.name.toLowerCase().includes(query.trim().toLowerCase())
  const aliveRows = useMemo(() => {
    const rows = alive.filter(match)
    if (sort === 'seeds') return rows.sort((a, b) => b.seedTotal - a.seedTotal || byName(a, b))
    return rows.sort((a, b) => Number(b.me) - Number(a.me) || byName(a, b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, sort, query])
  const outRows = useMemo(
    () => out.filter(match).sort(sort === 'seeds' ? (a, b) => b.seedTotal - a.seedTotal || byName(a, b) : byName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [out, sort, query]
  )

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
            ? { key, team: null, label: 'No pick yet', tone: s.amber, rows: [] }
            : { key, team: null, label: hiddenUntil ? `Locked in · hidden until ${hiddenUntil}` : 'Locked in', tone: s.green, rows: [] })
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
    row.status === 'locked' || row.status === 'picked' ? { text: 'Locked in', tone: s.green }
      : row.status === 'submitted' ? { text: 'Submitted', tone: s.green }
        : { text: row.me ? 'Not submitted' : 'No pick yet', tone: s.amber }

  const sorts: [SortMode, string][] = [['alphabetical', 'Alphabetical'], ['team', 'By team'], ...(showSeedTotal && !compact ? [['seeds', 'Seed total'] as [SortMode, string]] : [])]

  const aliveRow = (row: AliveRow, grouped: boolean) => {
    const st = status(row)
    const pick = row.teams.length ? (
      <span className={s.teamLine}>
        <TeamLogo team={row.teams[0]} brands={teamBrands} size={18} />
        <span>{teamsText(row.teams)}{row.me && row.status === 'submitted' ? ' (submitted)' : ''}</span>
      </span>
    ) : row.status === 'locked' && hiddenUntil ? <span className={s.hidden}>Hidden until {hiddenUntil}</span> : <span />
    if (compact) {
      return (
        <div className={s.stRow} data-me={row.me} key={row.id}>
          <span>{row.me ? 'You' : row.name}</span>
          {grouped ? <span /> : row.teams.length ? pick : <span className={st.tone}>{st.text}</span>}
        </div>
      )
    }
    return (
      <div className={s.stRow} data-me={row.me} key={row.id}>
        <span>{row.me ? 'You' : row.name}</span>
        <span className={st.tone}>{st.text}</span>
        {sort === 'seeds' ? <span>{row.seedTotal}</span> : grouped ? <span /> : pick}
      </div>
    )
  }

  const outRow = (row: OutRow, grouped: boolean) => (
    <div className={`${s.stRow} ${s.stOut}`} key={row.id}>
      <span>{row.name}</span>
      {compact ? (
        <span className={grouped ? undefined : s.red}>{grouped ? row.out : row.teams.length ? `${row.out} · ${teamsText(row.teams)}` : row.out}</span>
      ) : (
        <>
          <span>{row.out}</span>
          {sort === 'seeds' ? <span>{row.seedTotal}</span> : <span className={s.red}>{grouped ? '' : row.losing ?? 'Out'}</span>}
        </>
      )}
    </div>
  )

  const groupHead = (group: Group<AliveRow | OutRow>) => (
    <div className={s.teamGroup} key={`h-${group.key}`}>
      {group.team ? <TeamLogo team={group.team} brands={teamBrands} size={22} /> : null}
      <b className={group.tone}>{group.label}</b>
      <span>{group.rows.length}</span>
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

      <section className={s.stSection} aria-label="Still alive">
        <div className={s.stHead}><b className={s.green}>{alive.length}</b><span>still alive</span></div>
        {!compact && <div className={`${s.stRow} ${s.stLabels}`}><span>Entry</span><span>Status</span><span>{sort === 'seeds' ? 'Seed total' : `${dayLabel} pick`}</span></div>}
        {grouped
          ? groupAlive(aliveRows).flatMap((group) => [groupHead(group), ...group.rows.map((row) => aliveRow(row, true))])
          : aliveRows.map((row) => aliveRow(row, false))}
        {aliveRows.length === 0 && <p className={s.empty}>No match.</p>}
      </section>

      {out.length > 0 && (
        <section className={s.stSection} aria-label="Eliminated">
          <div className={s.stHead}><b className={s.red}>{out.length}</b><span>eliminated</span></div>
          {!compact && <div className={`${s.stRow} ${s.stLabels}`}><span>Entry</span><span>Out</span><span>{sort === 'seeds' ? 'Seed total' : 'Losing pick'}</span></div>}
          {grouped
            ? groupOut(outRows).flatMap((group) => [groupHead({ ...group, tone: s.red }), ...group.rows.map((row) => outRow(row, true))])
            : outRows.map((row) => outRow(row, false))}
          {outRows.length === 0 && <p className={s.empty}>No match.</p>}
        </section>
      )}
    </div>
  )
}
