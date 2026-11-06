'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SweatGame, SweatResponse } from '@/app/api/sweat/route'
import { tipTime } from '@/lib/poolTheme'
import { RETRY_MS, nextPollMs } from '@/lib/livePolling'
import { SweatBoardSkeleton } from '@/app/components/PoolLoading'
import TeamLogo from '@/app/components/TeamLogo'
import type { TeamBrandDirectory } from '@/lib/teamBrand'
import s from '@/app/components/pp.module.css'

type Side = 'away' | 'home'

const sweatUrl = (sandbox: boolean) => (sandbox ? '/api/sweat?sandbox=1' : '/api/sweat')
type Standing = 'safe' | 'lead' | 'trail' | 'wait' | 'out'

// Each count's color comes from the stylesheet (data-k); the label always
// says the same thing in words.
const YOU_LABEL: Record<Standing, string> = { safe: 'Safe', lead: 'Leading', trail: 'Trailing', wait: 'To play', out: 'Out' }
const SUM_LABEL: Record<Standing, string> = { safe: 'Won', lead: 'Leading', trail: 'Trailing', wait: 'To play', out: 'Lost today' }
const STANDINGS: Standing[] = ['safe', 'lead', 'trail', 'wait', 'out']

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
  teamBrands: pageBrands,
  myTeams,
  sandbox = false,
  kicker,
}: {
  teamBrands: TeamBrandDirectory
  myTeams: string[] | null
  // Test-mode browsers read a separate, never-cached address (see the route).
  sandbox?: boolean
  kicker: string
}) {
  const [data, setData] = useState<SweatResponse | null>(null)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showOthers, setShowOthers] = useState(false)
  const live = data?.hasLiveGames ?? false

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    // A failed request keeps the timing of the last good one.
    let body: SweatResponse | null = null
    async function load() {
      try {
        const res = await fetch(sweatUrl(sandbox))
        if (!res.ok) throw new Error()
        body = await res.json()
        if (!cancelled) { setData(body); setUpdated(new Date()); setError(false) }
      } catch {
        if (!cancelled) setError(true)
      }
      const schedule = (body?.games ?? []).map((game) => ({ state: game.state, kickoff: game.kickoff, timeTbd: game.statusText.toLowerCase().includes('tbd') }))
      if (!cancelled) timer = window.setTimeout(load, body ? nextPollMs(schedule, body.hasLiveGames) : RETRY_MS)
    }
    load()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [retry, sandbox])

  // The feed sends the brands for every game it shows; the page's own set
  // covers the first paint.
  const teamBrands = useMemo(() => ({ ...pageBrands, ...(data?.brands ?? {}) }), [pageBrands, data?.brands])
  const name = (team: string) => teamBrands[team]?.shortName ?? team
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
  const groupsOf = (list: SweatGame[]) => [
    { key: 'in', title: 'Live now', sub: revealed ? 'Most at risk first' : '', games: list.filter((g) => g.state === 'in').sort((a, b) => atRisk(b) - atRisk(a)) },
    { key: 'pre', title: 'Up next', sub: '', games: list.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()) },
    { key: 'post', title: 'Final', sub: '', games: list.filter((g) => g.state === 'post').sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()) },
  ].filter((group) => group.games.length > 0)
  // Games the pool has a stake in come first: every game with a pool pick
  // once picks are revealed, your own game before then. The rest of the
  // slate stays one tap away.
  const stakeGames = revealed
    ? games.filter((game) => game.awayPlayers.length + game.homePlayers.length > 0)
    : myGame ? [myGame] : []
  const otherGames = games.filter((game) => !stakeGames.includes(game))
  const split = stakeGames.length > 0 && otherGames.length > 0

  const distribution = new Map<string, number>()
  for (const player of data?.players ?? []) if (player.team) distribution.set(player.team, (distribution.get(player.team) ?? 0) + 1)
  const dist = [...distribution.entries()].sort((a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0])))
  const distMax = Math.max(1, ...dist.map(([, n]) => n))
  const outToday = (data?.players ?? []).filter((player) => player.status === 'lost')
  const autoPlayers = (data?.players ?? []).filter((player) => player.auto)
  const autoTeams = [...new Set(autoPlayers.map((player) => player.team).filter(Boolean) as string[])]
  const missed = summary?.noPick ?? 0

  const renderGroups = (list: SweatGame[]) => groupsOf(list).map((group) => (
                <div key={group.key}>
                  <div className={s.groupHead}><h3>{group.title} <span>{group.games.length}</span></h3><span>{group.sub}</span></div>
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
                            const won = game.state === 'post' && side.standing === 'safe'
                            const tone = side.standing === 'trail' || side.standing === 'out' ? s.red : side.standing === 'safe' || side.standing === 'lead' ? s.green : undefined
                            return [
                              <span key={`t-${side.side}`} className={`${s.sTeam} ${lost ? s.loser : won ? s.winner : ''}`} style={{ gridRow: index + 1 }}>
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
              ))

  return (
    <>
      <div className={s.sweatHead}>
        <div>
          {kicker && <div className={s.kicker}>{kicker}</div>}
          <h1 className={s.title}>Sweat board</h1>
        </div>
        <div className={s.liveNote}>
          {live && <span className={s.liveDot} />}
          {live ? 'Live scores' : 'Scores'}
          {updated && <>, updated {updated.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}</>}
        </div>
      </div>

      {error && (
        <p role="alert" className={s.notice}>
          {data ? 'Updates are unavailable. Showing the last scores received.' : 'Could not load the sweat board.'}{' '}
          <button type="button" className={s.linkButton} onClick={() => setRetry(retry + 1)}>Try again</button>
        </p>
      )}
      {!data && !error && <SweatBoardSkeleton />}

      {data && (
        <>
          <section className={s.youBar} aria-label="Your status">
            <div className={s.youMain}>
              {myTeams === null ? (
                <div>
                  <div className={s.cellLabel}>Pool</div>
                  <div className={s.youTeam}>{data.entriesToday} playing today</div>
                  <div className={s.youLine}>{revealed ? `Picks revealed at ${lockText}` : `Picks are hidden until ${lockText}`}</div>
                </div>
              ) : myTeam ? (
                <>
                  <TeamLogo team={myTeam} brands={teamBrands} size={48} />
                  <div style={{ minWidth: 0 }}>
                    <div className={s.cellLabel}>You: {myStanding ? YOU_LABEL[myStanding] : 'To play'}</div>
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
              <ul className={s.sumGrid} aria-label="Today's picks">
                {STANDINGS.map((key) => (
                  <li key={key} data-k={key}>
                    <span className={s.sumNum}>{counts[key]}</span>
                    <span className={s.sumLabel}>{SUM_LABEL[key]}</span>
                  </li>
                ))}
              </ul>
              {/* The same counts as a bar; the list above says it in words. */}
              <div className={s.segs} aria-hidden="true">
                {STANDINGS.map((key) => <span key={key} data-k={key} style={{ flex: counts[key] }} />)}
              </div>
              {counts.out > 0 && <p className={s.sumNote}>Lost today counts finished games. Standings change when the day’s results are graded.</p>}
            </div>
          </section>

          <div className={`${s.split} ${s.sweatSplit}`}>
            <section aria-label="Games">
              <div className={s.sweatCols}><span>Game</span><span>Team</span><span>Score</span><span>Pool<span className={s.longLabel}> picks</span></span><span>Stakes</span></div>
              {split ? (
                <>
                  <h2 className={s.sweatSection}>{revealed ? 'Games with pool picks' : 'Your game'}</h2>
                  {renderGroups(stakeGames)}
                  <div className={s.othersToggle}>
                    <button type="button" className={s.textButton} aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>
                      {showOthers ? 'Hide other games' : `Show ${otherGames.length} other ${otherGames.length === 1 ? 'game' : 'games'}`}
                    </button>
                  </div>
                  {showOthers && <><h2 className={s.sweatSection}>Other games</h2>{renderGroups(otherGames)}</>}
                </>
              ) : renderGroups(games)}
              {games.length === 0 && <p className={s.empty}>No games yet. The board fills in when the next slate is set.</p>}
            </section>

            <aside className={`${s.aside} ${s.sweatSide}`} aria-label="Pool picks">
              <div className={s.asideHead} style={{ paddingBottom: 0 }}><h2>Pool picks</h2></div>
              <div className={s.small}>{data.entriesToday} {data.entriesToday === 1 ? 'entry' : 'entries'} playing today. Picks {revealed ? 'revealed' : 'hidden until'} {lockText}.</div>
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
                <p className={s.small} style={{ marginTop: 12 }}>{summary?.hidden ?? 0} picks in, {summary?.pending ?? 0} not yet.</p>
              )}
              {revealed && (
                <div className={s.sub}>
                  <h3>Lost today <span className={s.red}>{outToday.length}</span></h3>
                  <p className={s.small}>{outToday.length ? outToday.map((player) => player.name).join(', ') : 'Nobody yet.'}</p>
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

        </>
      )}
    </>
  )
}
