import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { formatCentralTime } from '@/lib/deadline'
import { getTeamAbbrs } from '@/lib/teams'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, type PickPeriod } from '@/lib/competition'

interface WeekRow {
  id: string
  slate_number: number
  slate_date: string
  season_year: number
  is_active: boolean
}

interface GameRow {
  id: string
  slate_id: string
  home_team: string
  away_team: string
  result: string
  tip_time: string
  round_label: string | null
}

export default async function AdminHistoryPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()
  const allTeams = await getTeamAbbrs(supabase)
  const pool = await getPoolConfig(supabase)

  const [{ data: slates }, { data: games }, { data: picks }, { data: players }] = await Promise.all([
    supabase.from('slates').select('id, slate_number, slate_date, season_year, is_active').order('slate_number'),
    supabase.from('games').select('id, slate_id, home_team, away_team, result, tip_time, round_label').order('tip_time'),
    supabase.from('picks').select('slate_id, team, auto_assigned'),
    supabase.from('players').select('full_name, email, status, elimination_slate, elimination_reason'),
  ])

  const weekRows: WeekRow[] = slates || []

  // Label each row the way players see it, so an admin reading history and a
  // player reading their picks are looking at the same thing.
  const periodById: Record<string, PickPeriod> = {}
  for (const p of buildPickPeriods(
    pool.competition_mode,
    weekRows.map((w) => ({
      id: w.id,
      slate_number: w.slate_number,
      slate_date: String(w.slate_date),
      locks_at: null,
    })),
    (games || []).map((g) => ({ slate_id: g.slate_id, round_label: g.round_label }))
  )) {
    periodById[p.id] = p
  }
  const gamesByWeek = new Map<string, GameRow[]>()
  for (const g of games || []) {
    const list = gamesByWeek.get(g.slate_id) || []
    list.push(g)
    gamesByWeek.set(g.slate_id, list)
  }

  const pickStatsByWeek = new Map<string, { total: number; auto: number; byTeam: Record<string, number> }>()
  for (const p of picks || []) {
    const stats = pickStatsByWeek.get(p.slate_id) || { total: 0, auto: 0, byTeam: {} }
    stats.total++
    if (p.auto_assigned) stats.auto++
    stats.byTeam[p.team] = (stats.byTeam[p.team] || 0) + 1
    pickStatsByWeek.set(p.slate_id, stats)
  }

  const realPlayers = (players || []).filter((p) => !p.email?.endsWith('@nflsurvivor.internal'))
  const elimsByWeek = new Map<number, { full_name: string; elimination_reason: string | null }[]>()
  for (const p of realPlayers) {
    if (p.status === 'eliminated' && p.elimination_slate != null) {
      const list = elimsByWeek.get(p.elimination_slate) || []
      list.push({ full_name: p.full_name, elimination_reason: p.elimination_reason })
      elimsByWeek.set(p.elimination_slate, list)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Season History</h1>
        <p className="text-slate-400 mt-1">Every pick period&apos;s games, results, picks, and eliminations.</p>
      </div>

      {weekRows.length === 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800 p-6 text-center">
          <p className="text-slate-400">No pick periods created yet.</p>
        </div>
      )}

      {weekRows.map((slate) => {
        const weekGames = gamesByWeek.get(slate.id) || []
        const stats = pickStatsByWeek.get(slate.id)
        const elims = elimsByWeek.get(slate.slate_number) || []
        const topPicks = stats
          ? Object.entries(stats.byTeam).sort((a, b) => b[1] - a[1]).slice(0, 5)
          : []

        return (
          <div key={slate.id} className="rounded-xl border border-slate-700 bg-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-white text-lg">
                {periodById[slate.id]?.label ?? `Slate ${slate.slate_number}`} · {slate.season_year}
              </p>
              <div className="flex items-center gap-3">
                {slate.is_active && (
                  <span className="rounded-full bg-green-500/15 px-3 py-1 text-xs font-semibold text-green-400">ACTIVE</span>
                )}
                <span className="text-xs text-slate-400">
                  {stats?.total ?? 0} picks{stats && stats.auto > 0 ? ` (${stats.auto} auto)` : ''}
                </span>
              </div>
            </div>

            {weekGames.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-1.5 font-medium">Game</th>
                    <th className="py-1.5 font-medium hidden sm:table-cell">Tip (CT)</th>
                    <th className="py-1.5 font-medium text-right">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {weekGames.map((g) => (
                    <tr key={g.id} className="border-b border-slate-700/60 last:border-0">
                      <td className="py-1.5 font-mono text-white">
                        {g.away_team} @ {g.home_team}
                      </td>
                      <td className="py-1.5 text-slate-400 hidden sm:table-cell">{formatCentralTime(g.tip_time)}</td>
                      <td className="py-1.5 text-right">
                        {g.result === 'pending' ? (
                          <span className="text-xs text-amber-400">pending</span>
                        ) : g.result === 'tie' ? (
                          <span className="text-xs font-semibold text-red-400">TIE</span>
                        ) : (
                          <span className="text-xs font-semibold text-green-400">
                            {g.result === 'home_win' ? g.home_team : g.away_team} won
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-500">No games entered for this slate.</p>
            )}

            {topPicks.length > 0 && (
              <p className="text-xs text-slate-400">
                Most picked:{' '}
                {topPicks.map(([team, count], i) => (
                  <span key={team}>
                    {i > 0 && ' · '}
                    <span className="font-mono font-semibold text-slate-300">{team}</span> ×{count}
                  </span>
                ))}
              </p>
            )}

            {elims.length > 0 && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-400 mb-1.5">
                  Eliminated in Slate {slate.slate_number} ({elims.length})
                </p>
                <ul className="space-y-0.5 text-sm text-slate-300">
                  {elims.map((e) => (
                    <li key={e.full_name}>
                      {e.full_name}
                      {e.elimination_reason && <span className="text-slate-500"> — {e.elimination_reason}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      })}

      {/* Teams never yet picked across the season */}
      <NeverPicked picks={picks || []} allTeams={allTeams} />
    </div>
  )
}

function NeverPicked({ picks, allTeams }: { picks: { team: string }[]; allTeams: string[] }) {
  const pickedTeams = new Set(picks.map((p) => p.team))
  const never = allTeams.filter((t) => !pickedTeams.has(t))
  if (never.length === 0) return null
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-5">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
        Never Picked This Season ({never.length})
      </p>
      <p className="text-sm font-mono text-slate-300 leading-relaxed">{never.join(', ')}</p>
    </div>
  )
}
