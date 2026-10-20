'use client'

import { useEffect, useState } from 'react'
import type { SweatGame, SweatResponse } from '@/app/api/sweat/route'
import { tipTime } from '@/lib/poolTheme'
import { LiveBoardSkeleton } from '@/app/components/PageSkeletons'
import TeamLogo from '@/app/components/TeamLogo'
import type { TeamBrandDirectory } from '@/lib/teamBrand'
import s from '@/app/components/pp.module.css'

type Side = 'away' | 'home'
type Standing = 'safe' | 'lead' | 'trail' | 'wait' | 'out'

const SUMMARY_COLORS: Record<Standing, string> = {
  safe: '#5FD08F',
  lead: '#B7E4C7',
  trail: '#FFB3A8',
  wait: 'rgba(255,255,255,.35)',
  out: '#FF6B5C',
}

const YOU_LABEL: Record<Standing, string> = { safe: 'Safe', lead: 'Leading', trail: 'Trailing', wait: 'To play', out: 'Out' }

function standingOf(game: SweatGame | undefined, side: Side): Standing {
  if (!game || game.state === 'pre') return 'wait'
  const mine = side === 'away' ? game.awayScore : game.homeScore
  const theirs = side === 'away' ? game.homeScore : game.awayScore
  // A tie is never safe: an unfinished tie is trailing, a final one eliminates.
  if (game.state === 'post') return mine > theirs ? 'safe' : 'out'
  return mine > theirs ? 'lead' : 'trail'
}

function clockOf(game: SweatGame): string {
  if (game.state === 'post') return 'Final'
  if (game.state === 'in') return game.statusText.replace(/ - /g, ' ')
  return game.statusText.toLowerCase().includes('tbd') ? 'TBD' : tipTime(game.kickoff)
}

export default function SweatBoard({
  names,
  teamBrands,
  myTeams,
  kicker,
}: {
  names: Record<string, string>
  teamBrands: TeamBrandDirectory
  myTeams: string[] | null
  kicker: string
}) {
  const [data, setData] = useState<SweatResponse | null>(null)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const live = data?.hasLiveGames ?? false

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/sweat', { cache: 'no-store' })
        if (!res.ok) throw new Error()
        const body = await res.json()
        if (!cancelled) { setData(body); setUpdated(new Date()); setError(false) }
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    const timer = setInterval(load, live ? 30000 : 300000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [live, retry])

  const name = (team: string) => names[team] ?? team
  const revealed = data?.allRevealed ?? false
  const lockText = tipTime(data?.locksAt)
  const games = data?.games ?? []
  const gameOf = (team: string) => games.find((game) => game.homeTeam === team || game.awayTeam === team)
  const sideOf = (game: SweatGame, team: string): Side => (game.homeTeam === team ? 'home' : 'away')

  // Your own pick, which you can always see.
  const myTeam = myTeams?.[0] ?? null
  const myGame = myTeam ? gameOf(myTeam) : undefined
  const myStanding = myTeam && myGame ? standingOf(myGame, sideOf(myGame, myTeam)) : null

  const summary = data?.summary
  const counts: Record<Standing, number> = {
    safe: summary?.safe ?? 0,
    lead: summary?.winning ?? 0,
    trail: summary?.losing ?? 0,
    wait: (summary?.notStarted ?? 0) + (summary?.hidden ?? 0),
    out: summary?.out ?? 0,
  }

  const atRisk = (game: SweatGame) =>
    game.awayScore < game.homeScore ? game.awayPlayers.length : game.homeScore < game.awayScore ? game.homePlayers.length : game.awayPlayers.length + game.homePlayers.length
  const groups = [
    { key: 'in', title: 'Live now', sub: revealed ? 'Most at risk first' : '', games: games.filter((g) => g.state === 'in').sort((a, b) => atRisk(b) - atRisk(a)) },
    { key: 'pre', title: 'Up next', sub: '', games: games.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()) },
    { key: 'post', title: 'Final', sub: '', games: games.filter((g) => g.state === 'post').sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()) },
  ].filter((group) => group.games.length > 0)

  const distribution = new Map<string, number>()
  for (const player of data?.players ?? []) if (player.team) distribution.set(player.team, (distribution.get(player.team) ?? 0) + 1)
  const dist = [...distribution.entries()].sort((a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0])))
  const distMax = Math.max(1, ...dist.map(([, n]) => n))
  const outToday = (data?.players ?? []).filter((player) => player.status === 'lost')
  const autoPlayers = (data?.players ?? []).filter((player) => player.auto)
  const autoTeams = [...new Set(autoPlayers.map((player) => player.team).filter(Boolean) as string[])]
  const missed = summary?.noPick ?? 0

  return (
    <>
      <div className={s.sweatHead}>
        <div>
          {kicker && <div className={s.kicker}>{kicker}</div>}
          <h1 className={s.title}>Sweat board</h1>
        </div>
        <div className={s.liveNote}>
          {live && <span className={s.liveDot} />}
          {live ? 'Live' : 'Scores'}
          {updated && <> · updated {updated.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}</>}
          {data?.locksAt && <span className={s.liveExtra}> · picks revealed at {lockText}</span>}
        </div>
      </div>

      {error && (
        <p role="alert" className={s.notice}>
          {data ? 'Updates are unavailable. Showing the last scores received.' : 'Could not load the sweat board.'}{' '}
          <button type="button" className={s.linkButton} onClick={() => setRetry(retry + 1)}>Try again</button>
        </p>
      )}
      {!data && !error && <LiveBoardSkeleton heading={false} />}

      {data && (
        <>
          <section className={s.youBar} aria-label="Your status">
            <div className={s.youMain}>
              {myTeams === null ? (
                <div>
                  <div className={s.cellLabel}>Pool</div>
                  <div className={s.youTeam}>{data.aliveCount} alive</div>
                  <div className={s.youLine}>{revealed ? `Picks revealed at ${lockText}` : `Picks are hidden until ${lockText}`}</div>
                </div>
              ) : myTeam ? (
                <>
                  <TeamLogo team={myTeam} brands={teamBrands} size={48} />
                  <div style={{ minWidth: 0 }}>
                    <div className={s.cellLabel}>You · {myStanding ? YOU_LABEL[myStanding] : 'To play'}</div>
                    <div className={s.youTeam}>{myTeams.map(name).join(', ')}</div>
                    {myGame && (
                      <div className={s.youLine}>
                        vs {name(sideOf(myGame, myTeam) === 'home' ? myGame.awayTeam : myGame.homeTeam)} · {clockOf(myGame)}{myGame.tv ? ` · ${myGame.tv}` : ''}
                      </div>
                    )}
                  </div>
                  {myGame && myGame.state !== 'pre' && (
                    <div className={s.youScore}>
                      {sideOf(myGame, myTeam) === 'home' ? `${myGame.homeScore}–${myGame.awayScore}` : `${myGame.awayScore}–${myGame.homeScore}`}
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <div className={s.cellLabel}>You</div>
                  <div className={s.youTeam}>No pick</div>
                  <div className={s.youLine}>{revealed ? 'Missed the lock' : `Picks lock at ${lockText}`}</div>
                </div>
              )}
            </div>
            <div className={s.youSum}>
              <div className={s.sumGrid}>
                {(['safe', 'lead', 'trail', 'wait', 'out'] as Standing[]).map((key) => (
                  <div key={key}>
                    <div className={s.sumNum} style={{ color: key === 'wait' ? '#FFFFFF' : SUMMARY_COLORS[key] }}>{counts[key]}</div>
                    <div className={s.sumLabel}>{key === 'out' ? 'Out today' : YOU_LABEL[key]}</div>
                  </div>
                ))}
              </div>
              <div className={s.segs}>
                {(['safe', 'lead', 'trail', 'wait', 'out'] as Standing[]).map((key) => (
                  <span key={key} style={{ flex: counts[key], background: SUMMARY_COLORS[key] }} />
                ))}
              </div>
            </div>
          </section>

          <div className={s.split} style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', marginTop: 32 }}>
            <section aria-label="Games">
              <div className={s.sweatCols}><span>Game</span><span>Team</span><span>Score</span><span>Pool picks</span><span>Stakes</span></div>
              {groups.map((group) => (
                <div key={group.key}>
                  <div className={s.groupHead}><h2>{group.title} <span>{group.games.length}</span></h2><span>{group.sub}</span></div>
                  {group.games.map((game) => {
                    const sides = (['away', 'home'] as Side[]).map((side) => {
                      const team = side === 'away' ? game.awayTeam : game.homeTeam
                      const players = side === 'away' ? game.awayPlayers : game.homePlayers
                      const standing = standingOf(game, side)
                      return { side, team, players, standing, seed: side === 'away' ? game.awaySeed : game.homeSeed, score: side === 'away' ? game.awayScore : game.homeScore }
                    })
                    const total = sides.reduce((sum, side) => sum + side.players.length, 0)
                    const winner = sides.find((side) => side.standing === 'safe')
                    const stake = !revealed
                      ? { n: '', label: '', tone: undefined }
                      : game.state === 'in'
                        ? { n: String(atRisk(game)), label: 'at risk', tone: atRisk(game) > 0 ? s.red : undefined }
                        : game.state === 'pre'
                          ? total ? { n: String(total), label: 'riding', tone: undefined } : { n: '', label: 'No picks', tone: s.gray }
                          : winner && winner.players.length
                            ? { n: String(winner.players.length), label: 'advanced', tone: s.green }
                            : total ? { n: String(total), label: 'out', tone: s.red } : { n: '', label: 'No picks', tone: s.gray }
                    const showNames = !!open[game.id]
                    return (
                      <article className={s.sgame} key={game.id}>
                        <div className={s.sgameGrid}>
                          <div className={s.sgameMeta}>
                            {game.state === 'in' ? <span className={s.clockLive}>{clockOf(game)}</span> : <b>{clockOf(game)}</b>}
                            <span>{[game.group, game.tv].filter(Boolean).join(' · ')}</span>
                          </div>
                          {sides.map((side, index) => {
                            const lost = game.state === 'post' && side.standing === 'out'
                            const tone = side.standing === 'trail' || side.standing === 'out' ? s.red : side.standing === 'safe' || side.standing === 'lead' ? s.green : undefined
                            return [
                              <span key={`t-${side.side}`} className={`${s.sTeam} ${lost ? s.loser : ''}`} style={{ gridRow: index + 1 }}>
                                <span>{side.seed ?? ''}</span><TeamLogo team={side.team} brands={teamBrands} size={22} /><span>{name(side.team)}</span>
                              </span>,
                              <span key={`s-${side.side}`} className={`${s.sScore} ${lost ? s.loser : ''}`} style={{ gridRow: index + 1 }}>
                                {game.state === 'pre' ? '' : side.score}
                              </span>,
                              <span key={`p-${side.side}`} className={`${s.sPicks} ${tone ?? ''}`} style={{ gridRow: index + 1 }}>
                                {revealed && side.players.length ? side.players.length : ''}
                              </span>,
                            ]
                          })}
                          <div className={`${s.sStake} ${stake.tone ?? ''}`}><b>{stake.n}</b><span>{stake.label}</span></div>
                        </div>
                        <div className={s.sNamesRow}>
                          <div className={s.sNames}>
                            {showNames && sides.filter((side) => side.players.length).map((side) => (
                              <div key={side.side}><b className={side.standing === 'trail' || side.standing === 'out' ? s.red : undefined}>{name(side.team)}</b> · {side.players.join(', ')}</div>
                            ))}
                            {revealed && total > 0 && (
                              <button type="button" className={s.linkButton} aria-expanded={showNames} onClick={() => setOpen({ ...open, [game.id]: !showNames })}>
                                {showNames ? 'Hide names' : `Show ${total} ${total === 1 ? 'name' : 'names'}`}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ))}
              {groups.length === 0 && <p className={s.empty}>No games yet. The board fills in when the next slate is set.</p>}
            </section>

            <aside className={`${s.aside} ${s.sweatSide}`} aria-label="Pool picks">
              <div className={s.asideHead} style={{ paddingBottom: 0 }}><h2>Pool picks</h2></div>
              <div className={s.small}>{data.players.length} entries · {revealed ? `revealed at ${lockText}` : `hidden until ${lockText}`}</div>
              {revealed ? (
                <div style={{ marginTop: 12 }}>
                  {dist.map(([team, n]) => (
                    <div className={s.distRow} data-mine={myTeams?.includes(team) ?? false} key={team}>
                      <span className={s.teamLine}><TeamLogo team={team} brands={teamBrands} size={18} /><span>{name(team)}</span></span>
                      <span className={s.distTrack}><span style={{ width: `${(n / distMax) * 100}%` }} /></span>
                      <span>{n}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={s.small} style={{ marginTop: 12 }}>{summary?.hidden ?? 0} locked in · {summary?.pending ?? 0} no pick yet</p>
              )}
              {revealed && (
                <div className={s.sub}>
                  <h3>Out today <span className={s.red}>{outToday.length}</span></h3>
                  <p className={s.small} style={{ color: '#4B5563' }}>{outToday.length ? outToday.map((player) => player.name).join(', ') : 'Nobody yet.'}</p>
                </div>
              )}
              {(autoPlayers.length > 0 || missed > 0) && (
                <div className={`${s.sub} ${s.small}`}>
                  {autoPlayers.length > 0
                    ? `${autoPlayers.length} missed the lock and ${autoPlayers.length === 1 ? 'was' : 'were'} given ${autoTeams.map(name).join(', ')}: ${autoPlayers.map((player) => player.name).join(', ')}.`
                    : `${missed} missed the lock.`}
                </div>
              )}
            </aside>
          </div>

          {(autoPlayers.length > 0 || missed > 0) && (
            <p className={`${s.small} ${s.mobileOnly}`} style={{ marginTop: 16 }}>
              {autoPlayers.length > 0
                ? `${autoPlayers.length} auto-assigned after missing the lock: ${autoPlayers.map((player) => player.name).join(', ')}.`
                : `${missed} missed the lock.`}
            </p>
          )}
        </>
      )}
    </>
  )
}
