'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { ScheduleDay } from './page'
import type { LiveScoresResponse } from '@/app/api/live-scores/route'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { tipTime } from '@/lib/poolTheme'
import TeamLogo from '@/app/components/TeamLogo'
import { american, point } from '@/lib/oddsFormat'
import s from '@/app/components/pp.module.css'

export default function ScheduleBoard({ days, brands, tournament }: { days: ScheduleDay[]; brands: TeamBrandDirectory; tournament: boolean }) {
  const [date, setDate] = useState(days.find((d) => d.games.length)?.date ?? days[0]?.date ?? '')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState<LiveScoresResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/live-scores', { cache: 'no-store' })
        if (res.ok) {
          const json = await res.json()
          if (!cancelled) setLive(json)
        }
      } catch { /* scheduled games stay available */ }
    }
    load()
    const timer = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const day = days.find((d) => d.date === date)
  const name = (team: string) => brandFor(team, brands).shortName
  const games = (day?.games ?? []).filter((g) =>
    `${name(g.awayAbbr)} ${name(g.homeAbbr)} ${g.awayAbbr} ${g.homeAbbr}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const hasOdds = games.some((g) => g.odds)

  return (
    <>
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}>{day?.label ?? 'Upcoming games'}</div>
          <h1 className={s.title}>Schedule</h1>
        </div>
        <Link href="/pick" className={`${s.cta} ${s.ctaQuiet}`} style={{ width: 'auto', padding: '0 20px', height: 44 }}>Make your pick</Link>
      </div>

      <div className={s.toolbar}>
        <div className={`${s.tabs} ${s.dayTabs}`} role="tablist" aria-label="Day">
          {days.map((d) => {
            const noon = new Date(`${d.date}T12:00:00`)
            return (
              <button key={d.date} type="button" role="tab" aria-selected={date === d.date} onClick={() => setDate(d.date)}>
                {noon.toLocaleDateString('en-US', { weekday: 'short' })} {noon.getDate()}
              </button>
            )
          })}
        </div>
        <label className={s.search}>
          <span>Find a team</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Team" />
        </label>
      </div>

      <section style={{ marginTop: 24 }} aria-label={day?.label ?? 'Games'}>
        <div className={s.sectionHead}><h2>{day?.label ?? 'Games'}</h2><span>{games.length} games</span></div>
        {games.map((game, index) => {
          const result = live?.games.find((g) => g.homeTeam === game.homeAbbr && g.awayTeam === game.awayAbbr && g.kickoff.slice(0, 10) === game.kickoff.slice(0, 10))
          const started = result && result.state !== 'pre'
          const scores = started && result.scoresKnown !== false
          return (
            <div className={`${s.gameRow} ${s.scheduleRow}`} key={`${game.awayAbbr}${game.homeAbbr}${index}`}>
              <span className={s.gameTime}>
                {result?.state === 'in' ? <span className={s.clockLive}>{result.statusText}</span> : <b>{started ? 'Final' : game.timeTbd ? 'TBD' : tipTime(game.kickoff)}</b>}
                <span>{game.tv ?? ''}</span>
              </span>
              <span className={s.sides}>
                {([[game.awayAbbr, game.awaySeed, result?.awayScore], [game.homeAbbr, game.homeSeed, result?.homeScore]] as const).map(([team, seed, score], i) => {
                  const lost = result?.state === 'post' && scores && score! < (i === 0 ? result.homeScore : result.awayScore)
                  return (
                    <span className={s.side} data-note={lost ? 'used' : undefined} key={team}>
                      <span className={s.teamLine}>
                        <span className={s.tag}>{tournament && seed ? seed : !tournament && seed && seed <= 25 ? seed : ''}</span>
                        <TeamLogo team={team} brands={brands} size={24} />
                        {name(team)}
                      </span>
                      {scores ? <b className={s.sideScore}>{score}</b> : game.odds ? <span className={s.sideNote} style={{ color: '#6B7280' }}>{american(i === 0 ? game.odds.awayMoneyline : game.odds.homeMoneyline)}</span> : null}
                    </span>
                  )
                })}
              </span>
              <span className={s.group}>
                {tournament ? game.region ?? '' : ''}
                {game.odds && <span style={{ display: 'block' }}>Spread {point(game.odds.spreadHome)} · O/U {game.odds.total ?? '–'}</span>}
              </span>
            </div>
          )
        })}
        {games.length === 0 && <p className={s.empty}>{query ? 'No matching teams.' : 'No games scheduled this day.'}</p>}
      </section>
      {hasOdds && <p className={s.small} style={{ marginTop: 12 }}>Odds: The Odds API. Informational only.</p>}
    </>
  )
}
