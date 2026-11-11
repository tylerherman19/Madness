'use client'

import { useEffect, useState } from 'react'
import type { ScheduleDay } from './page'
import type { LiveScoresResponse } from '@/app/api/live-scores/route'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { formatClock } from '@/lib/deadline'
import { useViewerTimeZone } from '@/app/components/LocalTime'
import TeamLogo from '@/app/components/TeamLogo'
import { american, point } from '@/lib/oddsFormat'
import { RETRY_MS, nextPollMs } from '@/lib/livePolling'
import s from '@/app/components/pp.module.css'

export default function ScheduleBoard({ days, brands, tournament, sandbox = false }: { days: ScheduleDay[]; brands: TeamBrandDirectory; tournament: boolean; sandbox?: boolean }) {
  const [date, setDate] = useState(days.find((d) => d.games.length)?.date ?? days[0]?.date ?? '')
  const [query, setQuery] = useState('')
  const viewerZone = useViewerTimeZone()
  const [live, setLive] = useState<LiveScoresResponse | null>(null)

  // Scores from the same feed and on the same timing as the ticker: often
  // while games are on, rarely once the day is done. Test mode reads its own
  // never-cached address.
  useEffect(() => {
    let dead = false
    let timer: number | undefined
    let body: LiveScoresResponse | null = null
    const load = async () => {
      try {
        const res = await fetch(sandbox ? '/api/live-scores?sandbox=1' : '/api/live-scores')
        if (res.ok) body = await res.json()
        if (res.ok && !dead) setLive(body)
      } catch { /* scheduled games stay available */ }
      finally {
        if (!dead) timer = window.setTimeout(load, body ? nextPollMs(body.games, body.hasLiveGames) : RETRY_MS)
      }
    }
    load()
    return () => { dead = true; window.clearTimeout(timer) }
  }, [sandbox])

  const day = days.find((d) => d.date === date)
  const name = (team: string) => brandFor(team, brands).shortName
  const games = (day?.games ?? []).filter((g) =>
    `${name(g.awayAbbr)} ${name(g.homeAbbr)} ${g.awayAbbr} ${g.homeAbbr}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const hasOdds = games.some((g) => g.odds)

  return (
    <>
      <h1 className={s.title}>Schedule</h1>

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
                {result?.state === 'in' ? <span className={s.clockLive}>{result.statusText}</span> : <b>{started ? 'Final' : game.timeTbd ? 'TBD' : formatClock(game.kickoff, viewerZone, false)}</b>}
                <span>{game.tv ?? ''}</span>
              </span>
              <span className={s.sides}>
                {([[game.awayAbbr, game.awaySeed, result?.awayScore], [game.homeAbbr, game.homeSeed, result?.homeScore]] as const).map(([team, seed, score], i) => {
                  const other = i === 0 ? result?.homeScore : result?.awayScore
                  const outcome = result?.state === 'post' && scores && score != null && other != null ? (score > other ? 'won' : score < other ? 'lost' : undefined) : undefined
                  return (
                    <span className={s.side} data-result={outcome} key={team}>
                      <span className={s.teamLine}>
                        <span className={s.tag}>{tournament && seed ? seed : !tournament && seed && seed <= 25 ? seed : ''}</span>
                        <TeamLogo team={team} brands={brands} size={24} />
                        {name(team)}
                      </span>
                      {scores ? <b className={s.sideScore}>{score}</b> : game.odds ? <span className={s.sideNote}>{american(i === 0 ? game.odds.awayMoneyline : game.odds.homeMoneyline)}</span> : null}
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
