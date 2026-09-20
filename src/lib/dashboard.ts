import 'server-only'
import type { StandingRow, TeamStat, Slate, Game } from '@/types'
import { computeInsights } from '@/lib/insights'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, capabilitiesFor, type CompetitionMode, type PickPeriod } from '@/lib/competition'
import { getTeamBrandDirectory } from '@/lib/teamBrand'
import { compareBySeedTotal, seedTotalsByPlayer } from '@/lib/standings'

export async function getDashboardData() {
  try {
    const { slateDeadline, isPickRevealed } = await import('@/lib/deadline')

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let allWeeks: any[] | null = null
    let allPlayers: any[] | null = null
    let allPicks: any[] | null = null
    let allGames: any[] | null = null
    /* eslint-enable @typescript-eslint/no-explicit-any */

    {
      const { getDb } = await import('@/lib/testMode')
      const supabase = await getDb()

      // Single Promise.all with 4 queries: all slates, all players, all picks with team, all games
      const [weeksRes, playersRes, picksRes, gamesRes] = await Promise.all([
        supabase.from('slates').select('*').order('slate_number'),
        supabase.from('players').select('id, full_name, email, status, elimination_slate, elimination_reason, paid').order('full_name'),
        supabase.from('picks').select('player_id, slate_id, team, seed'),
        supabase.from('games').select('*')
      ])
      allWeeks = weeksRes.data
      allPlayers = playersRes.data
      allPicks = picksRes.data
      allGames = gamesRes.data
    }

    if (!allPlayers) return null
    const players = allPlayers.filter((p: { email: string }) => !p.email?.endsWith('@nflsurvivor.internal'))
    const realPlayerIds = new Set(players.map((p: { id: string }) => p.id))

    const totalPaid = players.filter((p: { paid: boolean }) => p.paid).length
    const potSize = totalPaid * 25
    const alive = players.filter((p: { status: string }) => p.status === 'alive')
    const payoutPerSurvivor = alive.length > 0 ? Math.floor(potSize / alive.length) : 0

    // Find active slate from allWeeks
    const slate = (allWeeks || []).find((w: { is_active: boolean }) => w.is_active) || null

    // The pool's own configuration decides how all of this is presented. It
    // is read once here and threaded down — no component re-derives the mode.
    const pool = await getPoolConfig()
    const mode: CompetitionMode = pool.competition_mode

    // Everything derived below is scoped to the season currently being played
    // (season_year), read off the active slate like getSignupCutoff does — a
    // future season synced early, or last season's leftovers, must not get
    // folded into this season's carnage cards, survival curve, or team stats.
    // With no active slate there is nothing being played, so fall back to the
    // newest season_year present.
    const seasonAnchor =
      slate ||
      (allWeeks || [])
        .slice()
        .sort((a: { season_year: number }, b: { season_year: number }) => b.season_year - a.season_year)[0] ||
      null

    const seasonWeeks = (allWeeks || []).filter(
      (w: { season_year: number }) => !seasonAnchor || w.season_year === seasonAnchor.season_year
    )
    const seasonWeekIds = new Set<string>(seasonWeeks.map((w: { id: string }) => w.id))
    const seasonPicks = (allPicks || []).filter(
      (p: { slate_id: string; player_id: string }) => seasonWeekIds.has(p.slate_id) && realPlayerIds.has(p.player_id)
    )

    const currentPicks: Record<string, string[]> = {}
    // Subset of currentPicks that can be shown publicly — all of them, once
    // the slate locks at its first tip.
    const revealedPicks: Record<string, string> = {}
    let nextDeadline: string | null = null
    let nextDeadlineFormatted: string | null = null
    let picksRevealed = false

    if (slate) {
      // Filter picks for current slate from allPicks
      const picksData = (allPicks || []).filter((p: { slate_id: string }) => p.slate_id === slate.id)
      if (picksData) {
        for (const pick of picksData) {
          if (!realPlayerIds.has(pick.player_id)) continue
          currentPicks[pick.player_id] = [...(currentPicks[pick.player_id] ?? []), pick.team]
        }
      }

      // Filter games for current slate from allGames
      const gamesData = (allGames || []).filter((g: { slate_id: string }) => g.slate_id === slate.id)
      if (gamesData) {
        const { getEffectiveNow } = await import('@/lib/testMode')
        const now = await getEffectiveNow()
        const slateLockTime = slateDeadline(slate, gamesData)
        if (slateLockTime && slateLockTime > now) {
          nextDeadline = slateLockTime.toISOString()
          nextDeadlineFormatted = slateLockTime.toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        }
        picksRevealed = slateLockTime ? slateLockTime <= now : false

        // The slate reveals as a unit at its first tip, so this is one
        // decision for every pick rather than a per-team lookup.
        if (isPickRevealed(slate, gamesData, now)) {
          for (const [playerId, teams] of Object.entries(currentPicks)) {
            revealedPicks[playerId] = teams.join(', ')
          }
        }
      }
    }

    // Pick periods: the season's playing days, labelled for the active
    // competition. Regular season reads "Saturday, January 24"; the
    // tournament reads "First Round · Thursday".
    const periods = buildPickPeriods(
      mode,
      seasonWeeks.map((w: { id: string; slate_number: number; slate_date: string; locks_at: string | null }) => ({
        id: w.id,
        slate_number: w.slate_number,
        slate_date: String(w.slate_date),
        locks_at: w.locks_at,
      })),
      (allGames || []).map((g: { slate_id: string; round_label: string | null }) => ({
        slate_id: g.slate_id,
        round_label: g.round_label,
      }))
    )
    const currentPeriod = slate ? periods.find((p) => p.id === slate.id) ?? null : null
    const periodByNumber: Record<number, PickPeriod> = {}
    for (const p of periods) periodByNumber[p.number] = p

    // Today's slate facts, for the "Today's Pool" strip.
    const slateGames: Game[] = slate
      ? ((allGames || []).filter((g: { slate_id: string }) => g.slate_id === slate.id) as Game[])
      : []
    const announcedTips = slateGames
      .filter((g) => !g.time_tbd && !isNaN(new Date(g.tip_time).getTime()))
      .map((g) => new Date(g.tip_time).getTime())
      .sort((a, b) => a - b)
    const firstTip = announcedTips.length > 0 ? new Date(announcedTips[0]).toISOString() : null

    // "TODAY" only when the active slate really is today in Central — the
    // pool's own timezone. Every other day gets its own name.
    const centralToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const slateIsToday = slate ? String(slate.slate_date).slice(0, 10) === centralToday : false

    const { getTeamAbbrs } = await import('@/lib/teams')
    const { getDb } = await import('@/lib/testMode')
    const [teamUniverse, teamBrands] = await Promise.all([
      getTeamAbbrs(await getDb()),
      getTeamBrandDirectory(),
    ])

    // Count slates survived per player from this season's picks (including current slate)
    const weeksSurvivedByPlayer: Record<string, number> = {}
    // Sum of the seeds each player has taken — the tiebreak when more than
    // one survivor is left. Regular-season picks carry no seed, so this stays
    // at zero until the bracket is set.
    const seedTotalByPlayer = seedTotalsByPlayer(seasonPicks)
    for (const pick of seasonPicks) {
      weeksSurvivedByPlayer[pick.player_id] = (weeksSurvivedByPlayer[pick.player_id] || 0) + 1
    }

    const standings: StandingRow[] = players.map(
      (p: { id: string; full_name: string; status: string; elimination_reason: string | null; elimination_slate: number | null }) => ({
        player_id: p.id,
        full_name: p.full_name,
        status: p.status as 'alive' | 'eliminated',
        slates_survived: weeksSurvivedByPlayer[p.id] || 0,
        seed_total: seedTotalByPlayer[p.id] || 0,
        current_pick: currentPicks[p.id]?.[0] || null,
        current_picks: currentPicks[p.id] || [],
        pick_locked: (currentPicks[p.id]?.length ?? 0) > 0,
        pick_revealed: !!revealedPicks[p.id],
        elimination_reason: p.elimination_reason,
        elimination_slate: p.elimination_slate,
      })
    )

    standings.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
      return capabilitiesFor(mode).showSeedTotal
        ? compareBySeedTotal(a, b)
        : b.slates_survived - a.slates_survived || a.full_name.localeCompare(b.full_name)
    })

    // Filter picks to exclude current slate for team stats
    const allPicksWithTeam = seasonPicks.filter((p: { slate_id: string }) => !slate || p.slate_id !== slate.id)

    const teamMap: Record<string, { times_picked: number; wins: number; eliminations: number }> = {}
    if (allPicksWithTeam) {
      const winnersByWeek: Record<string, string[]> = {}
      for (const g of allGames || []) {
        if (g.result === 'home_win') winnersByWeek[g.slate_id] = [...(winnersByWeek[g.slate_id] || []), g.home_team]
        else if (g.result === 'away_win') winnersByWeek[g.slate_id] = [...(winnersByWeek[g.slate_id] || []), g.away_team]
      }
      for (const pick of allPicksWithTeam) {
        if (!teamMap[pick.team]) teamMap[pick.team] = { times_picked: 0, wins: 0, eliminations: 0 }
        teamMap[pick.team].times_picked++
        const winners = winnersByWeek[pick.slate_id] || []
        if (winners.includes(pick.team)) teamMap[pick.team].wins++
        else if (winners.length > 0) teamMap[pick.team].eliminations++
      }
    }

    const teamStats: TeamStat[] = Object.entries(teamMap)
      .map(([team, stats]) => ({
        team,
        times_picked: stats.times_picked,
        win_rate: stats.times_picked > 0 ? stats.wins / stats.times_picked : 0,
        eliminations_caused: stats.eliminations,
      }))
      .sort((a, b) => b.times_picked - a.times_picked)

    const picksMade = alive.filter((p: { id: string }) => (currentPicks[p.id]?.length ?? 0) > 0).length
    const picksPending = alive.length - picksMade

    // Everything the editorial modules need is already in hand — the insight
    // layer is a pure function over it, and only ever sees revealed picks for
    // the current slate.
    const insights = computeInsights({
      players,
      picks: seasonPicks,
      currentSlate: slate,
      revealedCurrentPicks: revealedPicks,
      potSize,
      teamUniverse,
    })

    return {
      pool,
      mode,
      periods,
      currentPeriod,
      periodByNumber,
      slateIsToday,
      gameCount: slateGames.length,
      slateGames,
      firstTip,
      slate: slate as Slate | null,
      standings,
      teamStats,
      potSize,
      payoutPerSurvivor,
      aliveCount: alive.length,
      eliminatedCount: players.length - alive.length,
      totalPlayers: players.length,
      nextDeadline,
      nextDeadlineFormatted,
      picksRevealed,
      picksMade,
      picksPending,
      insights,
      teamBrands,
    }
  } catch {
    return null
  }
}
