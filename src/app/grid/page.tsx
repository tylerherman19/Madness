import ContestRefresh from '@/app/components/ContestRefresh'
import { publicPlayerLabels } from '@/lib/playerLabels'
import { pageMetadata } from '@/lib/site'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { slateDeadline, isPickRevealed } from '@/lib/deadline'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, capabilitiesFor, type PickPeriod } from '@/lib/competition'
import type { Game } from '@/types'
import { loadAll, loadGamesForSlates, loadPicksForSlates, seasonYearOf } from '@/lib/seasonData'
import PoolShell from '@/app/components/PoolShell'
import TeamLogo from '@/app/components/TeamLogo'
import { brandFor, getTeamBrandDirectory } from '@/lib/teamBrand'
import { eventLabel, roundShort, weekdayDay } from '@/lib/poolTheme'
import s from '@/app/components/pp.module.css'

// Cache the render for 60s (like the homepage) so 1k concurrent viewers are
// served from the CDN instead of each triggering the full query set. Current-slate
// picks stay hidden behind the reveal deadline regardless of cache freshness.
export const revalidate = 60

export const metadata = pageMetadata('Pick Grid', 'Explore the Pick and Pray survivor pick grid and revealed picks by game day.', '/grid', true)

export default async function GridPage() {
  // Guard the fetch so a DB outage (or a build without env) degrades to the
  // empty state instead of failing the render / prerender.
  let slates: { id: string; slate_number: number; slate_date: string; season_year: number; locks_at: string | null }[] = []
  let players: { id: string; full_name: string; status: string; elimination_slate: number | null }[] = []
  let allPicks: { player_id: string; slate_id: string; team: string }[] = []
  let allGames: { slate_id: string; home_team: string; away_team: string; result: string; tip_time: string; round_label: string | null }[] = []
  let pool = await getPoolConfig()
  try {
    const supabase = await getDb()
    const [allSlates, playersRes] = await Promise.all([
      loadAll<typeof slates[number] & { is_active: boolean }>(
        supabase, 'slates', 'id, slate_number, slate_date, season_year, locks_at, is_active'
      ),
      supabase.from('players').select('id, full_name, status, elimination_slate').not('email', 'like', '%@nflsurvivor.internal').order('full_name'),
    ])
    // One season's grid — the one being played — paged past the row cap.
    const seasonYear = seasonYearOf(allSlates)
    slates = allSlates
      .filter((w) => w.season_year === seasonYear && (!pool.starts_on || w.slate_date >= pool.starts_on))
      .sort((a, b) => a.slate_number - b.slate_number)
    const seasonIds = slates.map((w) => w.id)
    players = playersRes.data ?? []
    ;[allPicks, allGames] = await Promise.all([
      loadPicksForSlates<typeof allPicks[number]>(supabase, seasonIds, 'player_id, slate_id, team'),
      // tip_time is what every deadline/reveal calculation below keys
      // off — leaving it out of this select silently pins every pick as hidden.
      loadGamesForSlates<typeof allGames[number]>(
        supabase, seasonIds, 'slate_id, home_team, away_team, result, tip_time, round_label'
      ),
    ])
    pool = await getPoolConfig(supabase)
  } catch {
    // fall through to empty state
  }

  const labels = publicPlayerLabels(players)
  players = players.map(player => ({ ...player, full_name: labels.get(player.id) ?? player.full_name }))
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

  const teamBrands = await getTeamBrandDirectory()
  const names = Object.fromEntries(Object.entries(teamBrands).map(([abbr, brand]) => [abbr, brand.shortName]))
  const columnLabel = (slateId: string, index: number) => {
    const period = periodById[slateId]
    return (caps.showTournamentRounds && roundShort(period?.round)) || `Day ${index + 1}`
  }

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} names={names}>
      <ContestRefresh />
      <div className={s.pickHeader}>
        <div>
          <div className={s.kicker}>{eventLabel(mode, pool.season_year)}</div>
          <h1 className={s.title}>Pick grid</h1>
        </div>
        <a href="/api/grid/export" className={`${s.cta} ${s.ctaQuiet}`} style={{ width: 'auto', padding: '0 20px', height: 44 }}>Export to Excel</a>
      </div>

      {slates.length === 0 ? (
        <p className={s.notice}>No pick days scheduled yet.</p>
      ) : (
        <div className={s.gridWrap} role="region" aria-label="Every entry's picks by day" tabIndex={0}>
          <table className={s.gridTable}>
            <thead>
              <tr>
                <th scope="col">Entry</th>
                {slates.map((w, index) => (
                  <th scope="col" key={w.id}>
                    {columnLabel(w.id, index)}
                    <small>{periodById[w.id] ? weekdayDay(periodById[w.id].date) : ''}</small>
                    {topPickByWeek[w.id] && <small>{brandFor(topPickByWeek[w.id]!.team, teamBrands).shortName} ×{topPickByWeek[w.id]!.count}</small>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {withStats.length === 0 && (
                <tr><td colSpan={slates.length + 1} className={s.gridEmpty}>No entries yet.</td></tr>
              )}
              {withStats.map((player) => (
                <tr key={player.id} data-out={player.status === 'eliminated'}>
                  <th scope="row">{player.full_name}</th>
                  {slates.map((w) => {
                    const teams = pickMap[player.id]?.[w.id] ?? []
                    if (!teams.length) return <td key={w.id} className={s.gridNone}>–</td>
                    if (!isRevealed(w.id)) return <td key={w.id} className={s.gridNone}>Hidden</td>
                    const outcomes = resultMap[player.id]?.[w.id] ?? []
                    const outcome: Outcome = outcomes.includes('lost')
                      ? 'lost'
                      : outcomes.length > 0 && outcomes.every((result) => result === 'won')
                        ? 'won'
                        : 'pending'
                    return (
                      <td key={w.id} data-result={outcome}>
                        {teams.map((team) => (
                          <span className={s.teamLine} key={team}><TeamLogo team={team} brands={teamBrands} size={18} />{team}</span>
                        ))}
                        {outcome !== 'pending' && <span className="sr-only">, {outcome}</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.small} style={{ marginTop: 12 }}>Green won · red lost · picks stay hidden until each day locks.</p>
    </PoolShell>
  )
}
