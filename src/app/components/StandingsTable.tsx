'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { StandingRow } from '@/types'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import TeamChip from './TeamChip'

type SortMode = 'seeds' | 'alphabetical' | 'team'

function byName(a: StandingRow, b: StandingRow): number {
  return a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
}

export default function StandingsTable({
  aliveRows,
  elimRows,
  periodLabel,
  periodByNumber,
  teamBrands,
  signupsClosed,
  showSeedTotal,
}: {
  aliveRows: StandingRow[]
  elimRows: StandingRow[]
  periodLabel: string | null
  periodByNumber: Record<number, { shortLabel: string }>
  teamBrands: TeamBrandDirectory
  signupsClosed: boolean
  showSeedTotal: boolean
}) {
  const [sortMode, setSortMode] = useState<SortMode>(showSeedTotal ? 'seeds' : 'alphabetical')

  const sortedAliveRows = useMemo(() => {
    const rows = aliveRows.slice()
    if (sortMode === 'seeds') {
      return rows.sort((a, b) => b.seed_total - a.seed_total || byName(a, b))
    }
    if (sortMode === 'alphabetical') return rows.sort(byName)
    return rows.sort((a, b) => {
      // The server strips unrevealed teams before this component receives the
      // rows. pick_locked keeps submitted hidden picks ahead of missing picks.
      const aBucket = a.current_pick ? 0 : a.pick_locked ? 1 : 2
      const bBucket = b.current_pick ? 0 : b.pick_locked ? 1 : 2
      if (aBucket !== bBucket) return aBucket - bBucket
      if (a.current_pick && b.current_pick) {
        const teamOrder = brandFor(a.current_pick, teamBrands).name.localeCompare(
          brandFor(b.current_pick, teamBrands).name,
          undefined,
          { sensitivity: 'base' }
        )
        if (teamOrder !== 0) return teamOrder
      }
      return byName(a, b)
    })
  }, [aliveRows, sortMode, teamBrands])

  const sortedElimRows = useMemo(
    () => elimRows.slice().sort(showSeedTotal ? (a, b) => b.seed_total - a.seed_total || byName(a, b) : byName),
    [elimRows, showSeedTotal]
  )
  const isEmpty = aliveRows.length === 0 && elimRows.length === 0

  return (
    <>
      {!isEmpty && (
        <div className="mb-3 flex justify-end" aria-label="Sort standings">
          <div className="inline-flex rounded-full p-1" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)' }}>
            {([...(showSeedTotal ? ['seeds'] as const : []), 'alphabetical', 'team'] as SortMode[]).map((mode) => {
              const active = sortMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSortMode(mode)}
                  className="rounded-full px-3 py-1.5 text-xs font-bold"
                  style={{ background: active ? 'var(--dark)' : 'transparent', color: active ? 'white' : 'var(--muted)' }}
                >
                  {mode === 'seeds' ? 'Seed total' : mode === 'alphabetical' ? 'Alphabetical' : 'Team'}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              <th className="py-2.5 pl-4 text-left eyebrow w-full">Player</th>
              <th className="py-2.5 px-4 text-left eyebrow hidden sm:table-cell whitespace-nowrap">Status</th>
              {showSeedTotal && <th className="py-2.5 px-3 text-right eyebrow whitespace-nowrap">Seeds</th>}
              <th className="py-2.5 pl-4 pr-4 text-left eyebrow whitespace-nowrap">{periodLabel ? `${periodLabel} Pick` : 'Pick'}</th>
            </tr>
          </thead>
          <tbody>
            {isEmpty && (
              <tr>
                <td colSpan={showSeedTotal ? 4 : 3} className="p-8 text-center">
                  <strong className="block mb-2">The field is open</strong>
                  <p className="text-sm text-[var(--muted)] mb-4">Players will appear here when they join the pool.</p>
                  {!signupsClosed && <Link href="/signup" className="btn-primary px-5">Join the pool</Link>}
                </td>
              </tr>
            )}

            {sortedAliveRows.length > 0 && (
              <tr>
                <td colSpan={showSeedTotal ? 4 : 3} className="pt-4 pb-1.5 pl-4">
                  <span className="pill pill-alive"><span className="pill-dot" />{sortedAliveRows.length} Still Alive</span>
                </td>
              </tr>
            )}
            {sortedAliveRows.map((row) => (
              <tr key={row.player_id} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="py-3 pl-4 font-bold" style={{ color: 'var(--dark)' }}>{row.full_name}</td>
                <td className="py-3 px-4 hidden sm:table-cell">
                  <span className="pill pill-alive"><span className="pill-dot" />Alive</span>
                </td>
                {showSeedTotal && <td className="py-3 px-3 text-right font-bold tnum" style={{ color: 'var(--dark)' }}>{row.seed_total}</td>}
                <td className="py-3 pl-4 pr-4">
                  {row.current_picks.length > 0 ? (
                    <span className="flex flex-wrap gap-1.5">{row.current_picks.map((team) => <TeamChip key={team} team={team} size={28} directory={teamBrands} />)}</span>
                  ) : row.pick_locked ? (
                    <span className="pill pill-alive"><span className="pill-dot" />Pick In</span>
                  ) : (
                    <span className="text-xs italic" style={{ color: 'var(--red)' }}>no pick yet</span>
                  )}
                </td>
              </tr>
            ))}

            {sortedElimRows.length > 0 && (
              <tr>
                <td colSpan={showSeedTotal ? 4 : 3} className="pt-6 pb-1.5 pl-4">
                  <span className="pill pill-out"><span className="pill-dot" />{sortedElimRows.length} Eliminated</span>
                </td>
              </tr>
            )}
            {sortedElimRows.map((row) => {
              const eliminatedIn = row.elimination_slate
              return (
                <tr key={row.player_id} className="border-t" style={{ borderColor: 'var(--border)', opacity: 0.65 }}>
                  <td className="py-2.5 pl-4 text-sm" style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{row.full_name}</td>
                  <td className="py-2.5 px-4 hidden sm:table-cell">
                    <span className="pill pill-out">Out{eliminatedIn ? ` · ${periodByNumber[eliminatedIn]?.shortLabel ?? `#${eliminatedIn}`}` : ''}</span>
                  </td>
                  {showSeedTotal && <td className="py-2.5 px-3 text-right font-bold tnum" style={{ color: 'var(--muted)' }}>{row.seed_total}</td>}
                  <td className="py-2.5 pl-4 pr-4 text-xs" style={{ color: 'var(--muted)' }}>{row.elimination_reason ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
