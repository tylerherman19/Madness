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
import PoolShell from '../components/PoolShell'
import TeamLogo from '../components/TeamLogo'
import s from '../components/pp.module.css'
import { brandFor, getTeamBrandDirectory } from '@/lib/teamBrand'
import { loadAll } from '@/lib/seasonData'

export const metadata = pageMetadata('Your Pick History', 'Review your Pick and Pray survivor picks, results, and account alerts.', '/history', false)

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
    return formatPeriodDateShort(period.date)
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

  const names = Object.fromEntries(Object.entries(teamBrands).map(([abbr, brand]) => [abbr, brand.shortName]))
  const stats = [
    { label: 'Status', value: myStatus === 'alive' ? 'Alive' : 'Out', tone: myStatus === 'alive' ? s.green : s.red },
    { label: 'Record', value: `${wins}–${losses}` },
    ...(caps.showSeedTotal ? [{ label: 'Seed total', value: String(seedTotal) }] : []),
    { label: 'Outlasted', value: `${outlasted} of ${others.length}` },
  ]

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session.full_name} names={names} width="narrow">
      <div className={s.kicker}>{session.full_name}</div>
      <h1 className={s.title}>Pick history</h1>

      <section className={s.scoreboard} style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }} aria-label="Your season">
        {stats.map((stat) => (
          <div className={s.scoreCell} key={stat.label} style={{ display: 'block', borderLeft: stat.label === 'Status' ? 0 : undefined }}>
            <div className={s.cellLabel}>{stat.label}</div>
            <div className={`${s.cellValue} ${stat.tone ?? ''}`} style={stat.tone ? { color: stat.tone === s.green ? '#5FD08F' : '#FF6B5C' } : undefined}>{stat.value}</div>
          </div>
        ))}
      </section>

      <section className={s.stSection}>
        <div className={s.sectionHead}><h2>Your picks</h2><span>{picks.length} picks</span></div>
        {picks.length === 0 ? (
          <p className={s.empty}>No picks yet this season.</p>
        ) : (
          picks.map((pick) => (
            <div className={s.historyRow} key={pick.id}>
              <span className={s.gray}>{historyLabel(pick.slate_id)}</span>
              <span className={s.teamLine}><TeamLogo team={pick.team} brands={teamBrands} size={28} /><b>{brandFor(pick.team, teamBrands).shortName}</b></span>
              <span className={pick.outcome === 'won' ? s.green : pick.outcome === 'lost' ? s.red : s.gray}>
                {pick.outcome === 'won' ? 'Won' : pick.outcome === 'lost' ? 'Lost' : 'Pending'}
                {pick.auto_assigned ? ' · auto' : ''}
                {caps.showSeedTotal && pick.seed ? ` · seed ${pick.seed}` : ''}
              </span>
            </div>
          ))
        )}
      </section>

      <section className={s.stSection}>
        <div className={s.sectionHead}><h2>Teams left</h2><span>{teamsRemaining.length} of {allTeams.length}</span></div>
        {teamsRemaining.length === 0 ? (
          <p className={s.empty}>You have used every team.</p>
        ) : (
          <div className={s.teamCloud}>
            {teamsRemaining.map((team) => (
              <span className={s.teamLine} key={team}><TeamLogo team={team} brands={teamBrands} size={18} />{brandFor(team, teamBrands).shortName}</span>
            ))}
          </div>
        )}
      </section>
    </PoolShell>
  )
}
