import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getTeamAbbrs } from '@/lib/teams'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  formatPeriodDateShort,
  type PickPeriod,
} from '@/lib/competition'
import type { Slate, Game } from '@/types'
import SiteHeader from '../components/SiteHeader'
import TeamMark from '../components/TeamMark'
import { getTeamBrandDirectory } from '@/lib/teamBrand'

export default async function HistoryPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const supabase = await getDb()
  const pool = await getPoolConfig(supabase)
  const mode = pool.competition_mode
  const caps = capabilitiesFor(mode)

  const [picksRes, weeksRes, gamesRes, playersRes, allPicksRes, teamBrands] = await Promise.all([
    supabase.from('picks').select('team, auto_assigned, slate_id').eq('player_id', session.player_id),
    supabase.from('slates').select('id, slate_number, slate_date, season_year, locks_at'),
    supabase.from('games').select('slate_id, home_team, away_team, result, round_label'),
    supabase.from('players').select('id, status, email'),
    supabase.from('picks').select('player_id, slate_id'),
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
  const myStatus = allPlayers.find((p: { id: string }) => p.id === session.player_id)?.status ?? 'alive'

  const usedTeams = new Set(picksData.map((p: { team: string }) => p.team))
  const allTeams = await getTeamAbbrs(supabase)
  const teamsRemaining = allTeams.filter((t) => !usedTeams.has(t))

  // Percentile: how many other players this player has outlasted (slates survived = picks made)
  const survivedByPlayer: Record<string, number> = {}
  for (const pick of allPicks) {
    survivedByPlayer[pick.player_id] = (survivedByPlayer[pick.player_id] || 0) + 1
  }
  const mySurvived = picksData.length
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

      <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-10">
        <p className="text-sm font-bold" style={{ color: 'var(--orange-dark)' }}>Your season</p>
        <h1 className="font-display text-5xl mb-8" style={{ color: 'var(--dark)' }}>Pick history</h1>

        {/* Season summary */}
        <div className="grid grid-cols-3 border mb-8" style={{ borderColor: 'var(--border)', background: 'white' }}>
          <div className="py-4 px-4 text-center">
            <p
              className="font-display text-3xl leading-none"
              style={{ color: myStatus === 'alive' ? 'var(--green)' : 'var(--red)' }}
            >
            {myStatus === 'alive' ? 'Alive' : 'Out'}
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Status</p>
          </div>
          <div className="py-4 px-4 text-center" style={{ borderLeft: '1px solid var(--border)' }}>
            <p className="font-display text-3xl leading-none" style={{ color: 'var(--dark)' }}>
              {wins}–{losses}
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: 'var(--muted)' }}>Record</p>
          </div>
          <div className="py-4 px-4 text-center" style={{ borderLeft: '1px solid var(--border)' }}>
            <p className="font-display text-3xl leading-none" style={{ color: 'var(--dark)' }}>
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
                key={pick.slate_id}
                className="flex items-center justify-between gap-4 py-3 border-b"
                style={{ borderColor: 'var(--border)' }}
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
                  <span
                    className="text-xs font-bold tracking-wider"
                    style={{
                      color: pick.outcome === 'won' ? 'var(--green)' : pick.outcome === 'lost' ? 'var(--red)' : 'var(--muted)',
                    }}
                  >
                    {pick.outcome === 'won' ? '✓ SURVIVED' : pick.outcome === 'lost' ? '✗ ELIMINATED' : 'PENDING'}
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
                  style={{ borderColor: 'var(--border)', color: 'var(--dark)', background: 'white' }}
                  title={t}
                >
                  <TeamMark team={t} directory={teamBrands} size={24} />
                </span>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
