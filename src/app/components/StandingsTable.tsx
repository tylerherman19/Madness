'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import s from './pp.module.css'

export interface AliveRow {
  id: string
  name: string
  me: boolean
  // Team(s) shown in the pick column: revealed picks, or your own.
  pick: string | null
  status: 'locked' | 'none' | 'submitted' | 'picked'
  seedTotal: number
}

export interface OutRow {
  id: string
  name: string
  out: string
  losing: string | null
  seedTotal: number
}

type SortMode = 'alphabetical' | 'team' | 'seeds'

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export default function StandingsTable({
  alive,
  out,
  dayLabel,
  hiddenUntil,
  showSeedTotal,
  signupsClosed,
}: {
  alive: AliveRow[]
  out: OutRow[]
  dayLabel: string
  hiddenUntil: string | null
  showSeedTotal: boolean
  signupsClosed: boolean
}) {
  const [sort, setSort] = useState<SortMode>('alphabetical')
  const [query, setQuery] = useState('')

  const match = (row: { name: string }) => row.name.toLowerCase().includes(query.trim().toLowerCase())
  const aliveRows = useMemo(() => {
    const rows = alive.filter(match)
    if (sort === 'seeds') return rows.sort((a, b) => b.seedTotal - a.seedTotal || byName(a, b))
    if (sort === 'team') {
      // Revealed teams first, grouped; then locked-in entries; then no pick.
      const bucket = (row: AliveRow) => (row.pick && !row.me ? 0 : row.status === 'locked' || row.me ? 1 : 2)
      return rows.sort((a, b) => bucket(a) - bucket(b) || (a.pick ?? '').localeCompare(b.pick ?? '') || byName(a, b))
    }
    return rows.sort((a, b) => Number(b.me) - Number(a.me) || byName(a, b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, sort, query])
  const outRows = useMemo(
    () => out.filter(match).sort(sort === 'seeds' ? (a, b) => b.seedTotal - a.seedTotal || byName(a, b) : byName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [out, sort, query]
  )

  const sorts: [SortMode, string][] = [['alphabetical', 'Alphabetical'], ['team', 'By team'], ...(showSeedTotal ? [['seeds', 'Seed total'] as [SortMode, string]] : [])]
  const status = (row: AliveRow) =>
    row.status === 'locked' ? { text: 'Locked in', tone: s.green }
      : row.status === 'picked' ? { text: 'Locked in', tone: s.green }
        : row.status === 'submitted' ? { text: 'Submitted', tone: s.green }
          : { text: row.me ? 'Not submitted' : 'No pick yet', tone: s.amber }

  if (alive.length === 0 && out.length === 0) {
    return (
      <div className={s.stSection}>
        <p className={s.empty}>Entries appear here when players join.</p>
        {!signupsClosed && <Link className={s.cta} href="/signup" style={{ width: 220 }}>Join the pool</Link>}
      </div>
    )
  }

  return (
    <>
      <div className={s.toolbar}>
        <div className={s.tabs} role="tablist" aria-label="Sort">
          {sorts.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={sort === key} onClick={() => setSort(key)}>{label}</button>
          ))}
        </div>
        <label className={s.search}>
          <span>Find an entry</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'Name'} />
        </label>
      </div>

      <section className={s.stSection} aria-label="Still alive">
        <div className={s.stHead}><b className={s.green}>{alive.length}</b><span>still alive</span></div>
        <div className={`${s.stRow} ${s.stLabels}`}><span>Entry</span><span>Status</span><span>{sort === 'seeds' ? 'Seed total' : `${dayLabel} pick`}</span></div>
        {aliveRows.map((row) => {
          const st = status(row)
          return (
            <div className={s.stRow} data-me={row.me} key={row.id}>
              <span>{row.me ? 'You' : row.name}</span>
              <span className={st.tone}>{st.text}</span>
              {sort === 'seeds' ? (
                <span>{row.seedTotal}</span>
              ) : row.pick ? (
                <span>{row.pick}{row.me && row.status === 'submitted' ? ' (submitted)' : ''}</span>
              ) : row.status === 'locked' && hiddenUntil ? (
                <span className={s.hidden}>Hidden until {hiddenUntil}</span>
              ) : (
                <span />
              )}
            </div>
          )
        })}
        {aliveRows.length === 0 && <p className={s.empty}>No match.</p>}
      </section>

      {out.length > 0 && (
        <section className={s.stSection} aria-label="Eliminated">
          <div className={s.stHead}><b className={s.red}>{out.length}</b><span>eliminated</span></div>
          <div className={`${s.stRow} ${s.stLabels}`}><span>Entry</span><span>Out</span><span>{sort === 'seeds' ? 'Seed total' : 'Losing pick'}</span></div>
          {outRows.map((row) => (
            <div className={`${s.stRow} ${s.stOut}`} key={row.id}>
              <span>{row.name}</span>
              <span>{row.out}</span>
              {sort === 'seeds' ? <span>{row.seedTotal}</span> : <span className={s.red}>{row.losing ?? 'Out'}</span>}
            </div>
          ))}
          {outRows.length === 0 && <p className={s.empty}>No match.</p>}
        </section>
      )}
    </>
  )
}
