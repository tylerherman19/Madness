'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Game } from '@/types'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import TeamMark from './TeamMark'

export default function GameCenter({ games, brands }: { games: Game[]; brands: TeamBrandDirectory }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All games')
  const [limit, setLimit] = useState(6)
  const visible = games.filter(game => {
    const names = [game.home_team, game.away_team].map(team => brandFor(team, brands).name).join(' ')
    return `${names} ${game.home_team} ${game.away_team}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'All games' || (filter === 'Upcoming' ? game.status_state !== 'in' && game.status_state !== 'post' && game.result === 'pending' : game.status_state === 'post' || game.result !== 'pending'))
  }).sort((a, b) => Number(a.time_tbd) - Number(b.time_tbd) || new Date(a.tip_time).getTime() - new Date(b.tip_time).getTime())

  return <section className="matchup-board" aria-label="Game-day matchups">
    <div className="board-toolbar">
      <div className="board-filters" aria-label="Filter games">{['All games', 'Upcoming', 'Final'].map(label => <button key={label} aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}{label === 'All games' && <span>{games.length}</span>}</button>)}</div>
      <label className="team-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" aria-label="Search teams" placeholder="Find a team" value={query} onChange={event => setQuery(event.target.value)}/></label>
    </div>
    <div className="matchup-grid">
      {visible.slice(0, limit).map(game => {
        const final = game.status_state === 'post' || game.result !== 'pending'
        const live = game.status_state === 'in'
        const status = final ? 'Final' : live ? `${game.display_clock ?? ''} • Period ${game.period ?? 1}` : game.time_tbd ? 'Time TBD' : new Date(game.tip_time).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT'
        return <article className="matchup" key={game.id}>
          <div className="matchup-meta"><span className={live ? 'game-in-progress' : ''}>{live && <i/>}{status}</span><span>{game.tv || (game.round_label ?? 'College basketball')}</span></div>
          {([['away', game.away_team, game.away_score], ['home', game.home_team, game.home_score]] as const).map(([side, team, score]) => <div className="matchup-team" key={side} style={{ '--club-color': brandFor(team, brands).primary } as React.CSSProperties}>
            <TeamMark team={team} directory={brands} showName size={42}/>
            <strong className="matchup-score">{(live || final) && score != null ? score : final && game.result === `${side}_win` ? 'W' : '—'}</strong>
          </div>)}
          <div className="matchup-bottom"><span>{game.venue || 'Game-day matchup'}</span><Link href={final || live ? '/live' : '/pick'} aria-label={`${final || live ? 'View' : 'Pick from'} ${game.away_team} versus ${game.home_team}`}>{final || live ? 'Game details' : 'Make a pick'}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg></Link></div>
        </article>
      })}
    </div>
    {visible.length > limit && <button className="board-more" onClick={() => setLimit(limit + 6)}>Show more games <span>{visible.length - limit} remaining</span></button>}
    {visible.length === 0 && <div className="board-empty"><h3>{games.length === 0 ? 'The next slate is on its way' : 'No matching games'}</h3><p>{games.length === 0 ? 'Check the schedule for upcoming matchups.' : 'Try another team or game filter.'}</p>{games.length > 0 ? <button className="btn-secondary px-4" onClick={() => { setQuery(''); setFilter('All games') }}>Clear filters</button> : <Link className="btn-secondary px-4" href="/schedule">View schedule</Link>}</div>}
    <p className="board-note">Times shown in Central. Live scores update in the score scroll and Live board.</p>
  </section>
}
