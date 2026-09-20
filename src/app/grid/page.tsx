import { getDb, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline, isPickRevealed } from '@/lib/deadline'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, capabilitiesFor, type PickPeriod } from '@/lib/competition'
import type { Game } from '@/types'
import SiteHeader from '@/app/components/SiteHeader'
import { Footer } from '@/app/components/Sports'

// Cache the render for 60s (like the homepage) so 1k concurrent viewers are
// served from the CDN instead of each triggering the full query set. Current-slate
// picks stay hidden behind the reveal deadline regardless of cache freshness.
export const revalidate = 60

export default async function GridPage() {
  // Guard the fetch so a DB outage (or a build without env) degrades to the
  // empty state instead of failing the render / prerender.
  let slates: { id: string; slate_number: number; slate_date: string; season_year: number; locks_at: string | null }[] = []
  let players: { id: string; full_name: string; status: string; elimination_slate: number | null }[] = []
  let allPicks: { player_id: string; slate_id: string; team: string }[] = []
  let allGames: { slate_id: string; home_team: string; away_team: string; result: string; tip_time: string; time_tbd: boolean; round_label: string | null }[] = []
  let pool = await getPoolConfig()
  try {
    const supabase = await getDb()
    const [weeksRes, playersRes, picksRes, gamesRes] = await Promise.all([
      supabase.from('slates').select('id, slate_number, slate_date, season_year, locks_at').order('slate_number'),
      supabase.from('players').select('id, full_name, status, elimination_slate').not('email', 'like', '%@nflsurvivor.internal').order('full_name'),
      supabase.from('picks').select('player_id, slate_id, team'),
      // tip_time is what every deadline/reveal calculation below keys
      // off — leaving it out of this select silently pins every pick as hidden.
      // time_tbd matters just as much in the other direction: without it a
      // slate whose tips ESPN hasn't announced falls back to the
      // midnight-Eastern placeholders, which read as 11pm Central the night
      // before and reveal picks that can still be changed.
      supabase.from('games').select('slate_id, home_team, away_team, result, tip_time, time_tbd, round_label'),
    ])
    slates = weeksRes.data ?? []
    players = playersRes.data ?? []
    allPicks = picksRes.data ?? []
    allGames = gamesRes.data ?? []
    pool = await getPoolConfig(supabase)
  } catch {
    // fall through to empty state
  }

  const mode = pool.competition_mode
  const caps = capabilitiesFor(mode)

  // Columns are named the way the active competition names its pick periods —
  // a date in the regular season, a bracket round in the tournament.
  const periods = buildPickPeriods(
    mode,
    slates.map((w) => ({
      id: w.id,
      slate_number: w.slate_number,
      slate_date: String(w.slate_date),
      locks_at: w.locks_at,
    })),
    allGames.map((g) => ({ slate_id: g.slate_id, round_label: g.round_label }))
  )
  const periodById: Record<string, PickPeriod> = {}
  for (const p of periods) periodById[p.id] = p

  // Build game lookup: slateId -> Game[]
  const gamesByWeek: Record<string, Game[]> = {}
  for (const g of allGames) {
    if (!gamesByWeek[g.slate_id]) gamesByWeek[g.slate_id] = []
    gamesByWeek[g.slate_id].push(g as Game)
  }

  const now = await getEffectiveNow()

  // Build pick map: playerId -> slateId -> teams. Round quotas can put two
  // selections on the same calendar slate.
  const pickMap: Record<string, Record<string, string[]>> = {}
  for (const pick of allPicks) {
    if (!pickMap[pick.player_id]) pickMap[pick.player_id] = {}
    if (!pickMap[pick.player_id][pick.slate_id]) pickMap[pick.player_id][pick.slate_id] = []
    pickMap[pick.player_id][pick.slate_id].push(pick.team)
  }

  // A slate reveals as a unit at its first tip, so this is memoised per
  // slate rather than per slate+team.
  const slateById: Record<string, { locks_at?: string | null }> = {}
  for (const w of slates) slateById[w.id] = w

  const revealCache: Record<string, boolean> = {}
  const isRevealed = (slateId: string): boolean => {
    if (revealCache[slateId] === undefined) {
      revealCache[slateId] = isPickRevealed(
        slateById[slateId] ?? null,
        gamesByWeek[slateId] ?? [],
        now
      )
    }
    return revealCache[slateId]
  }

  // Most-picked team per slate, only for slates that have locked
  const realPlayerIds = new Set(players.map((p) => p.id))
  const topPickByWeek: Record<string, { team: string; count: number } | null> = {}
  for (const w of slates) {
    const weekGames = gamesByWeek[w.id] ?? []
    const deadline = slateDeadline(slateById[w.id] ?? null, weekGames)
    const revealed = deadline ? deadline <= now : false
    if (!revealed) {
      topPickByWeek[w.id] = null
      continue
    }
    const counts: Record<string, number> = {}
    for (const pick of allPicks) {
      if (pick.slate_id !== w.id || !realPlayerIds.has(pick.player_id)) continue
      counts[pick.team] = (counts[pick.team] || 0) + 1
    }
    let top: { team: string; count: number } | null = null
    for (const [team, count] of Object.entries(counts)) {
      if (!top || count > top.count) top = { team, count }
    }
    topPickByWeek[w.id] = top
  }

  // Build result map: playerId -> slateId -> outcome
  type Outcome = 'won' | 'lost' | 'pending'
  const resultMap: Record<string, Record<string, Outcome[]>> = {}
  for (const pick of allPicks) {
    const games = gamesByWeek[pick.slate_id] ?? []
    const game = games.find((g) => g.home_team === pick.team || g.away_team === pick.team)
    let outcome: Outcome = 'pending'
    if (game && game.result !== 'pending') {
      if (game.result === 'home_win') outcome = pick.team === game.home_team ? 'won' : 'lost'
      else if (game.result === 'away_win') outcome = pick.team === game.away_team ? 'won' : 'lost'
      else outcome = 'lost'
    }
    if (!resultMap[pick.player_id]) resultMap[pick.player_id] = {}
    if (!resultMap[pick.player_id][pick.slate_id]) resultMap[pick.player_id][pick.slate_id] = []
    resultMap[pick.player_id][pick.slate_id].push(outcome)
  }

  // Sort players: alive first (by slates survived desc, then name), then eliminated (by elimination_slate desc, then name)
  const withStats = players.map((p) => ({
    ...p,
    weeksSurvived: Object.values(pickMap[p.id] ?? {}).reduce((total, teams) => total + teams.length, 0),
  }))
  withStats.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
    if (a.status === 'alive') {
      if (b.weeksSurvived !== a.weeksSurvived) return b.weeksSurvived - a.weeksSurvived
      return a.full_name.localeCompare(b.full_name)
    }
    // both eliminated
    const aElim = a.elimination_slate ?? 0
    const bElim = b.elimination_slate ?? 0
    if (bElim !== aElim) return bElim - aElim
    return a.full_name.localeCompare(b.full_name)
  })

  return (
    <div className="site-shell">
      <SiteHeader mode={mode} />

      <main className="content-width py-9 sm:py-12">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-bold" style={{ color: 'var(--orange-dark)' }}>The full pool at a glance</p>
            <h1 className="font-display text-5xl leading-none" style={{ color: 'var(--dark)' }}>Pick grid</h1>
            <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              {caps.showTournamentRounds ? 'Every round' : 'Every game day'} · green won · red lost · ? hidden until it locks
            </p>
          </div>
          <a href="/api/grid/export" className="btn-primary shrink-0 px-4 py-2 text-center text-sm font-bold">
            Export to Excel
          </a>
        </div>

        {slates.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No {caps.showTournamentRounds ? 'tournament rounds' : 'game days'} scheduled yet.
          </p>
        ) : (
          <div>
            <p id="grid-scroll-hint" className="mb-2 text-xs sm:hidden" style={{ color: 'var(--muted)' }}>
              Swipe sideways to see every {caps.showTournamentRounds ? 'round' : 'game day'}.
            </p>
            <div className="card overflow-x-auto p-1" role="region" aria-label="Pool pick history" aria-describedby="grid-scroll-hint" tabIndex={0}>
              <table className="text-sm" style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  <th
                    className="text-left py-2 pr-4"
                    style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', minWidth: 140, position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}
                  >
                    Player
                  </th>
                  {slates.map((w) => (
                    <th
                      key={w.id}
                      className="py-2 px-1 text-center"
                      style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', minWidth: 44 }}
                    >
                      <span className="block whitespace-nowrap">{periodById[w.id]?.shortLabel ?? `#${w.slate_number}`}</span>
                      {topPickByWeek[w.id] && (
                        <span className="block font-mono" style={{ fontSize: 9, fontWeight: 400, color: 'var(--muted)' }}>
                          {topPickByWeek[w.id]!.team} ×{topPickByWeek[w.id]!.count}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {withStats.length === 0 && (
                  <tr>
                    <td colSpan={slates.length + 1} className="px-4 py-10 text-center" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      No entries yet. Players will appear here after they join the pool.
                    </td>
                  </tr>
                )}
                {withStats.map((player) => (
                  <tr key={player.id} style={{ borderBottom: '1px solid var(--border)', opacity: player.status === 'eliminated' ? 0.7 : 1 }}>
                    <td
                      className="py-2 pr-4"
                      style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: player.status === 'alive' ? 'var(--green)' : 'var(--red)' }}
                        />
                        <span className="font-medium" style={{ color: 'var(--dark)', whiteSpace: 'nowrap' }}>{player.full_name}</span>
                      </div>
                    </td>
                    {slates.map((w) => {
                      const teams = pickMap[player.id]?.[w.id] ?? []
                      const hidden = teams.length > 0 && !isRevealed(w.id)

                      if (!teams.length) {
                        return (
                          <td key={w.id} className="py-2 px-1 text-center" style={{ fontSize: 11, color: 'var(--muted)' }}>
                            —
                          </td>
                        )
                      }

                      if (hidden) {
                        return (
                          <td key={w.id} className="py-2 px-1 text-center" style={{ fontSize: 11, color: 'var(--muted)' }}>
                            ?
                          </td>
                        )
                      }

                      const outcomes = resultMap[player.id]?.[w.id] ?? []
                      const outcome: Outcome = outcomes.includes('lost')
                        ? 'lost'
                        : outcomes.length > 0 && outcomes.every((result) => result === 'won')
                          ? 'won'
                          : 'pending'
                      const cellStyle =
                        outcome === 'won'
                          ? { background: 'rgba(30,82,24,0.15)', color: 'var(--green)' }
                          : outcome === 'lost'
                          ? { background: 'rgba(180,30,30,0.15)', color: 'var(--red)' }
                          : { background: 'rgba(100,100,100,0.1)', color: 'var(--muted)' }

                      return (
                        <td
                          key={w.id}
                          className="py-2 px-1 text-center font-mono font-bold"
                          style={{ fontSize: 11, borderRadius: 2, ...cellStyle }}
                        >
                          {teams.join(' / ')}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
