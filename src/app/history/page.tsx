import { survivedPeriodsByPlayer } from '@/lib/survival'
import { pageMetadata } from '@/lib/site'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getTeamAbbrs } from '@/lib/teams'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import {
  buildPickPeriods,
  sharedRoundPickQuota,
  capabilitiesFor,
  formatPeriodDateShort,
  type PickPeriod,
} from '@/lib/competition'
import type { Slate, Game } from '@/types'
import SiteHeader from '../components/SiteHeader'
import { Footer } from '@/app/components/Sports'
import TeamMark from '../components/TeamMark'
import { getTeamBrandDirectory } from '@/lib/teamBrand'
import { loadAll } from '@/lib/seasonData'

export const metadata = pageMetadata('Your Pick History', 'Review your Madness survivor picks, results, and account alerts.', '/history', false)

export default async function HistoryPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const supabase = await getDb()
  const pool = await getPoolConfig(supabase)
  const mode = pool.competition_mode
  const caps = capabilitiesFor(mode)

  const [picksRes, weeksRes, gamesRes, playersRes, allPicksRes, teamBrands] = await Promise.all([
    supabase.from('picks').select('id, team, seed, auto_assigned, slate_id').eq('player_id', session.player_id),
    supabase.from('slates').select('id, slate_number, slate_date, season_year, locks_at'),
    loadAll<{ slate_id: string; home_team: string; away_team: string; result: string; round_label: string | null }>(
      supabase, 'games', 'slate_id, home_team, away_team, result, round_label'
    ).then((data) => ({ data })),
    supabase.from('players').select('id, status, email'),
    loadAll<{ player_id: string; slate_id: string; team: string }>(supabase, 'picks', 'player_id, slate_id, team').then((data) => ({ data })),
    getTeamBrandDirectory(),
  ])

  const picksData = picksRes.data ?? []
  const weeksData = weeksRes.data ?? []
  const gamesData = gamesRes.data ?? []
  const allPlayers = (playersRes.data ?? []).filter(
    (p: { email: string }) => !p.email?.endsWith('@nflsurvivor.internal')
  )
  const allPicks = allPicksRes.data ?? []

  const weekMap: Record<string, Slate> = {}
  for (const w of weeksData) weekMap[w.id] = w as Slate

  // Pick history is labelled by the thing the competition actually organises
  // around: the calendar day in a regular-season pool, the bracket round in a
  // tournament one. It is never a numbered "week" — college basketball has
  // none, and a tournament's rounds are not interchangeable with days.
  const periods = buildPickPeriods(
    mode,
    weeksData.map((w: { id: string; slate_number: number; slate_date: string; locks_at: string | null }) => ({
      id: w.id,
      slate_number: w.slate_number,
      slate_date: String(w.slate_date),
      locks_at: w.locks_at,
    })),
    gamesData.map((g: { slate_id: string; round_label: string | null }) => ({
      slate_id: g.slate_id,
      round_label: g.round_label,
    }))
  )
  const periodById: Record<string, PickPeriod> = {}
  for (const p of periods) periodById[p.id] = p

  // "FIRST ROUND · DAY 1" in the tournament; "JAN 6" in the regular season.
  const historyLabel = (slateId: string): string => {
    const period = periodById[slateId]
    if (!period) return '—'
    if (caps.labelPicksByRound && period.roundLabel) {
      return period.dayInRound && period.dayInRound > 1
        ? `${period.roundLabel} · Day ${period.dayInRound}`
        : period.roundLabel
    }
    return formatPeriodDateShort(period.date).toUpperCase()
  }

  const gamesByWeek: Record<string, Game[]> = {}
  for (const g of gamesData) {
    if (!gamesByWeek[g.slate_id]) gamesByWeek[g.slate_id] = []
    gamesByWeek[g.slate_id].push(g as Game)
  }

  type Outcome = 'won' | 'lost' | 'pending'

  const picks = picksData.map((pick) => {
    const slate = weekMap[pick.slate_id]
    const games = gamesByWeek[pick.slate_id] ?? []
    const game = games.find((g) => g.home_team === pick.team || g.away_team === pick.team)

    let outcome: Outcome = 'pending'
    if (game && game.result !== 'pending') {
      if (game.result === 'home_win') outcome = pick.team === game.home_team ? 'won' : 'lost'
      else if (game.result === 'away_win') outcome = pick.team === game.away_team ? 'won' : 'lost'
      else outcome = 'lost' // tie
    }

    return { ...pick, slate, outcome }
  })

  picks.sort((a, b) => (a.slate?.slate_number ?? 0) - (b.slate?.slate_number ?? 0))

  // Season summary stats for this player
  const wins = picks.filter((p) => p.outcome === 'won').length
  const losses = picks.filter((p) => p.outcome === 'lost').length
  const seedTotal = picks.reduce((total, pick) => total + (pick.seed ?? 0), 0)
  const myStatus = allPlayers.find((p: { id: string }) => p.id === session.player_id)?.status ?? 'alive'

  const usedTeams = new Set(picksData.map((p: { team: string }) => p.team))
  const allTeams = await getTeamAbbrs(supabase)
  const teamsRemaining = allTeams.filter((t) => !usedTeams.has(t))

  // Completed wins, grouped by game day; pending picks do not add survival.
  const survivedByPlayer = survivedPeriodsByPlayer(allPicks, gamesData, Object.fromEntries(periods.map(period => {
    const quota = sharedRoundPickQuota(mode, pool.pick_frequency, period.round)
    return [period.id, { key: quota ? period.round! : period.id, quota: quota ?? 1 }]
  })))
  const mySurvived = survivedByPlayer[session.player_id] ?? 0
  const others = allPlayers.filter((p: { id: string }) => p.id !== session.player_id)
  const outlasted = others.filter((p: { id: string; status: string }) => {
    const theirSurvived = survivedByPlayer[p.id] || 0
    // An alive player is never "outlasted"; an eliminated one is if they made fewer picks
    // (or the same number while this player is still alive)
    if (p.status === 'alive') return false
    return theirSurvived < mySurvived || (theirSurvived === mySurvived && myStatus === 'alive')
  }).length

  return (
    <div className="site-shell min-h-screen flex flex-col">
      <SiteHeader mode={mode} account={session.full_name} />

      <main id="main" className="flex-1 mx-auto w-full max-w-4xl px-4 py-10">
        <h1 className="font-display text-5xl mb-8" style={{ color: 'var(--ink)' }}>Pick history</h1>

        {/* Season summary */}
        <div className={`grid ${caps.showSeedTotal ? 'grid-cols-4' : 'grid-cols-3'} border mb-8`} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <div className="py-4 px-4 text-center">
            <p
              className="font-display text-3xl leading-none"
              style={{ color: myStatus === 'alive' ? 'var(--success)' : 'var(--danger)' }}
            >
            {myStatus === 'alive' ? 'Alive' : 'Out'}
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Status</p>
          </div>
          <div className="py-4 px-4 text-center" style={{ borderLeft: '1px solid var(--line)' }}>
            <p className="font-display text-3xl leading-none" style={{ color: 'var(--ink)' }}>
              {wins}–{losses}
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Record</p>
          </div>
          {caps.showSeedTotal && (
            <div className="py-4 px-2 text-center" style={{ borderLeft: '1px solid var(--line)' }}>
              <p className="font-display text-3xl leading-none" style={{ color: 'var(--ink)' }}>{seedTotal}</p>
              <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Seed total</p>
            </div>
          )}
          <div className="py-4 px-4 text-center" style={{ borderLeft: '1px solid var(--line)' }}>
            <p className="font-display text-3xl leading-none" style={{ color: 'var(--ink)' }}>
              {outlasted}/{others.length}
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Outlasted</p>
          </div>
        </div>

        {picks.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No picks yet this season.</p>
        ) : (
          <div>
            {picks.map((pick) => (
              <div
                key={pick.id}
                className="flex items-center justify-between gap-4 py-3 border-b"
                style={{ borderColor: 'var(--line)' }}
              >
                <div style={{ minWidth: 92, maxWidth: 170 }}>
                  <p className="text-xs font-bold tracking-widest uppercase leading-tight" style={{ color: 'var(--muted)' }}>
                    {historyLabel(pick.slate_id)}
                  </p>
                </div>
                <div className="flex-1">
                  <TeamMark team={pick.team} directory={teamBrands} size={40} showName />
                </div>
                <div className="text-right">
                  {caps.showSeedTotal && pick.seed && <span className="block text-xs font-bold mb-1" style={{ color: 'var(--accent-strong)' }}>+{pick.seed} seed</span>}
                  <span
                    className="text-xs font-bold tracking-wider"
                    style={{
                      color: pick.outcome === 'won' ? 'var(--success)' : pick.outcome === 'lost' ? 'var(--danger)' : 'var(--muted)',
                    }}
                  >
                    {pick.outcome === 'won' ? 'SURVIVED' : pick.outcome === 'lost' ? 'ELIMINATED' : 'PENDING'}
                    {pick.auto_assigned ? ' (auto)' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Teams remaining */}
        <div className="mt-10">
          <p className="text-xs font-bold tracking-widest uppercase mb-3" style={{ color: 'var(--muted)' }}>
            Teams Remaining ({teamsRemaining.length} of {allTeams.length})
          </p>
          {teamsRemaining.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>You&apos;ve used every team.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {teamsRemaining.map((t) => (
                <span
                  key={t}
                  className="border px-2 py-1 font-mono text-xs font-bold"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink)', background: 'var(--surface)' }}
                  title={t}
                >
                  <TeamMark team={t} directory={teamBrands} size={24} />
                </span>
              ))}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
