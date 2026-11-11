import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/testMode'
import { isUuid } from '@/lib/api'
import { pageMetadata } from '@/lib/site'
import { publicPlayerLabels } from '@/lib/playerLabels'
import { buildPickPeriods, capabilitiesFor, COMPETITION_MODES, type CompetitionMode } from '@/lib/competition'
import { buildHistoryRows, type ContestHistory } from '@/lib/contestHistoryRows'
import { getTeamBrandDirectory } from '@/lib/sharedData'
import { roundShort, weekdayDay } from '@/lib/poolTheme'
import PoolShell from '@/app/components/PoolShell'
import TeamLogo from '@/app/components/TeamLogo'
import GridScroller from '@/app/grid/GridScroller'
import s from '@/app/components/pp.module.css'

export const metadata = pageMetadata('Past Contest', 'Final standings and every pick from a finished Pick and Pray contest.', '/history', false)

// One finished contest: final standings and every pick. Every day shown here
// locked long ago, so all picks are public. contest_history() refuses the
// active contest, whose picks follow the normal reveal rule instead.
export default async function ContestHistoryPage({ params }: { params: Promise<{ contestId: string }> }) {
  const { contestId } = await params
  if (!isUuid(contestId)) notFound()
  const { data, error } = await (await getDb()).rpc('contest_history', { p_pool_id: contestId })
  if (error) throw error
  if (!data) notFound()
  const history = data as ContestHistory
  const mode: CompetitionMode = COMPETITION_MODES.includes(history.pool.competition_mode as CompetitionMode)
    ? history.pool.competition_mode as CompetitionMode
    : 'regular-season'
  const caps = capabilitiesFor(mode)
  const labels = publicPlayerLabels(history.entries)
  const rows = buildHistoryRows(history).map((row) => ({ ...row, name: labels.get(row.id) ?? row.name }))
  const slates = [...history.slates].sort((a, b) => String(a.slate_date).localeCompare(String(b.slate_date)))
  const periods = buildPickPeriods(
    mode,
    slates.map((slate) => ({ id: slate.id, slate_number: slate.slate_number, slate_date: String(slate.slate_date), locks_at: null })),
    history.games.map((game) => ({ slate_id: game.slate_id, round_label: game.round_label }))
  )
  const periodById = new Map(periods.map((period) => [period.id, period]))
  const teamBrands = await getTeamBrandDirectory()
  const alive = rows.filter((row) => row.status === 'alive').length

  return (
    <PoolShell mode={mode} seasonYear={history.pool.season_year}>
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}><Link href="/history">Past contests</Link></div>
          <h1 className={s.title}>{history.pool.name} · {history.pool.season_year}</h1>
          <p className={s.small}>
            {rows.length} {rows.length === 1 ? 'entry' : 'entries'} · {alive} still alive at the end
            {history.pool.ended_on ? ` · ended ${history.pool.ended_on}` : ''}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className={s.notice}>This contest has no entries.</p>
      ) : (
        <GridScroller laterCount={0} label="Final standings and every pick by day">
          <table className={s.gridTable}>
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Result</th>
                {slates.map((slate, index) => {
                  const period = periodById.get(slate.id)
                  return (
                    <th scope="col" key={slate.id}>
                      {(caps.showTournamentRounds && roundShort(period?.round)) || `Day ${index + 1}`}
                      <small>{period ? weekdayDay(period.date) : String(slate.slate_date)}</small>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-out={row.status === 'eliminated'}>
                  <th scope="row">{row.name}</th>
                  <td>{row.status === 'alive' ? `Alive · ${row.wins} won` : `Out${row.eliminationSlate != null ? ` · Slate ${row.eliminationSlate}` : ''}`}</td>
                  {slates.map((slate) => {
                    const picks = row.bySlate[slate.id] ?? []
                    if (!picks.length) return <td key={slate.id} className={s.gridNone}>–</td>
                    const outcome = picks.some((pick) => pick.outcome === 'lost') ? 'lost'
                      : picks.every((pick) => pick.outcome === 'won') ? 'won' : 'pending'
                    return (
                      <td key={slate.id} data-result={outcome}>
                        {picks.map((pick) => (
                          <span className={s.teamLine} key={pick.team}><TeamLogo team={pick.team} brands={teamBrands} size={18} />{pick.team}</span>
                        ))}
                        {outcome !== 'pending' && <span className="sr-only">, {outcome}</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </GridScroller>
      )}
      <p className={s.small} style={{ marginTop: 12 }}>
        Final standings{history.source === 'archive' ? ', read from the saved archive of this contest' : ''}. Picks that won are in green; picks that lost are in red.
      </p>
    </PoolShell>
  )
}
