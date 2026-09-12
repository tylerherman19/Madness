import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import {
  buildPickPeriods,
  capabilitiesFor,
  copyFor,
  formatPeriodDateShort,
  seedToShow,
  type CompetitionMode,
} from '@/lib/competition'
import type { Game } from '@/types'
import PickForm, { type GameRow } from './PickForm'
import SiteHeader from '../components/SiteHeader'
import { slateDeadline } from '@/lib/deadline'
import { fetchDayScoreboard } from '@/lib/espn'
import Link from 'next/link'
import { getTeamBrandDirectory, type TeamBrandDirectory } from '@/lib/teamBrand'
import TeamMark from '../components/TeamMark'
import { Footer } from '../components/Sports'

// Everything the pick page needs, loaded in one place. Kept separate from the
// render so no JSX is constructed inside the try/catch — React renders
// components lazily, so a throw during render would escape the catch anyway.
type PickPageData =
  | { kind: 'no-session' }
  | { kind: 'no-slate' }
  | { kind: 'failed' }
  | {
      kind: 'ok'
      playerStatus: string
      periodLabel: string
      usedTeams: string[]
      gameRows: GameRow[]
      slateId: string
      lockedPick: { team: string; autoAssigned: boolean } | null
      currentPick: { team: string; deadline: string | null } | null
      teamBrands: TeamBrandDirectory
    }

async function loadPickData(playerId: string, mode: CompetitionMode): Promise<PickPageData> {
  const caps = capabilitiesFor(mode)
  try {
    const supabase = await getDb()
    const { data: slate } = await supabase.from('slates').select('*').eq('is_active', true).single()
    if (!slate) return { kind: 'no-slate' }

    const { data: player } = await supabase
      .from('players')
      .select('id, full_name, status, paid')
      .eq('id', playerId)
      .single()
    if (!player) return { kind: 'no-session' }

    const [{ data: pastPicks }, { data: allSlates }, teamBrands] = await Promise.all([
      supabase.from('picks').select('team, slate_id').eq('player_id', playerId),
      supabase
        .from('slates')
        .select('id, slate_number, slate_date, locks_at')
        .eq('season_year', slate.season_year),
      getTeamBrandDirectory(),
    ])

    // Teams burned on previous pick periods — this period's pick isn't "used"
    // while it can still be changed. The date a team was spent travels with
    // it so the board can say *when*: "USED · JAN 18" is the difference
    // between a dead row and a useful one.
    const slateDateById: Record<string, string> = {}
    for (const s of allSlates ?? []) slateDateById[s.id] = String(s.slate_date)

    const usedOn: Record<string, string> = {}
    for (const p of pastPicks ?? []) {
      if (p.slate_id === slate.id) continue
      usedOn[p.team] = slateDateById[p.slate_id] ?? ''
    }
    const usedTeams = Object.keys(usedOn)

    const [{ data: currentPick }, { data: games }] = await Promise.all([
      supabase.from('picks').select('*').eq('player_id', playerId).eq('slate_id', slate.id).maybeSingle(),
      supabase.from('games').select('*').eq('slate_id', slate.id).order('tip_time'),
    ])
    const gamesData: Game[] = games || []

    const now = await getEffectiveNow()

    // Every pick on the slate locks together, at the day's first tip.
    const lockTime = slateDeadline(slate, gamesData)
    const locked = lockTime ? now >= lockTime : false

    // Records come off the slate's own scoreboard payload rather than a
    // league-wide teams call: ESPN's /teams endpoint ignores the conference
    // filter, and only the teams playing today matter on this page.
    const teamRecords: Record<string, string> = {}
    try {
      const { events } = await fetchDayScoreboard(String(slate.slate_date).replace(/-/g, ''), 3600)
      for (const event of events) {
        for (const c of event.competitions?.[0]?.competitors ?? []) {
          const abbr = c.team?.abbreviation
          const record = c.records?.[0]?.summary
          if (abbr && record) teamRecords[abbr] = record
        }
      }
    } catch { /* non-critical */ }

    // `curatedRank` lands in home_seed/away_seed for every game. Inside the
    // bracket it is a tournament seed; outside it, the AP poll position. Both
    // are useful, and they are never presented as the same thing.
    const pollRank = (team: string, g: Game): number | null => {
      if (!caps.showPollRank || g.round_label) return null
      const r = g.home_team === team ? g.home_seed : g.away_seed
      return r != null && r >= 1 && r <= 25 ? r : null
    }

    const sideOf = (team: string, g: Game, seed: number | null) => ({
      team,
      used: usedTeams.includes(team),
      usedOn: usedOn[team] ? formatPeriodDateShort(usedOn[team]).toUpperCase() : null,
      seed: seedToShow(mode, seed, g.round_label),
      rank: pollRank(team, g),
      record: teamRecords[team] ?? null,
    })

    const gameRows: GameRow[] = gamesData.map((g) => ({
      gameId: g.id,
      kickoff: g.tip_time,
      timeTbd: g.time_tbd,
      round: caps.showTournamentRounds ? g.round_label : null,
      region: caps.showRegions ? g.region : null,
      venue: g.venue,
      tv: g.tv,
      away: sideOf(g.away_team, g, g.away_seed),
      home: sideOf(g.home_team, g, g.home_seed),
      deadline: (lockTime ?? new Date(g.tip_time)).toISOString(),
      locked,
    }))

    // The pick period this page is asking about, named the way the active
    // competition names it.
    const periods = buildPickPeriods(
      mode,
      (allSlates ?? []).map((s) => ({
        id: s.id,
        slate_number: s.slate_number,
        slate_date: String(s.slate_date),
        locks_at: s.locks_at,
      })),
      gamesData.map((g) => ({ slate_id: g.slate_id, round_label: g.round_label }))
    )
    const period = periods.find((p) => p.id === slate.id) ?? null

    return {
      kind: 'ok',
      playerStatus: player.status,
      periodLabel: period?.label ?? `Slate ${slate.slate_number}`,
      usedTeams,
      gameRows,
      slateId: slate.id,
      lockedPick:
        currentPick && locked
          ? { team: currentPick.team, autoAssigned: !!currentPick.auto_assigned }
          : null,
      currentPick: currentPick
        ? { team: currentPick.team, deadline: lockTime?.toISOString() ?? null }
        : null,
      teamBrands,
    }
  } catch (err) {
    console.error('pick page load failed', err)
    return { kind: 'failed' }
  }
}

export default async function PickPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const pool = await getPoolConfig()
  const mode: CompetitionMode = pool.competition_mode
  const caps = capabilitiesFor(mode)
  const copy = copyFor(mode)

  const data = await loadPickData(session.player_id, mode)
  if (data.kind === 'no-session') redirect('/login')

  if (data.kind === 'failed') {
    return (
      <Shell session={session} mode={mode}>
        <p className="text-center text-sm" style={{ color: 'var(--muted)' }}>Failed to load. Try refreshing.</p>
      </Shell>
    )
  }

  if (data.kind === 'no-slate') {
    return (
      <Shell session={session} mode={mode}>
        <div className="text-center py-20">
          <p className="font-display text-4xl" style={{ color: 'var(--dark)' }}>
            {caps.showTournamentRounds ? 'NO ACTIVE ROUND' : 'NO ACTIVE GAME DAY'}
          </p>
          <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>The pool hasn&apos;t started yet — check back soon.</p>
        </div>
      </Shell>
    )
  }

  if (data.playerStatus === 'eliminated') {
    return (
      <Shell session={session} mode={mode} periodLabel={data.periodLabel}>
        <div className="border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
          <p className="font-display text-4xl" style={{ color: 'var(--red)' }}>ELIMINATED</p>
          <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>
            You can still follow along on the{' '}
            <Link href="/standings" className="underline" style={{ color: 'var(--dark)' }}>standings page</Link>.
          </p>
        </div>
      </Shell>
    )
  }

  if (data.lockedPick) {
    return (
      <Shell session={session} mode={mode} periodLabel={data.periodLabel}>
        <div className="space-y-6">
          <div className="border p-8 text-center" style={{ borderColor: 'var(--green)', borderWidth: 2 }}>
            <p className="text-sm font-bold mb-4" style={{ color: 'var(--green)' }}>
              Pick locked · {data.periodLabel}
            </p>
            <TeamMark team={data.lockedPick.team} directory={data.teamBrands} size={64} showName />
            {data.lockedPick.autoAssigned && (
              <p className="text-xs mt-3" style={{ color: 'var(--red)' }}>Auto-assigned (missed deadline)</p>
            )}
          </div>
          <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
            Teams used: {[...data.usedTeams, data.lockedPick.team].join(', ')}
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell session={session} mode={mode} periodLabel={data.periodLabel}>
      <PickForm
        slateId={data.slateId}
        periodLabel={data.periodLabel}
        pickHeading={copy.pickHeading}
        mode={mode}
        gameRows={data.gameRows}
        usedTeams={data.usedTeams}
        currentPick={data.currentPick}
        teamBrands={data.teamBrands}
      />
    </Shell>
  )
}

function Shell({
  children,
  session,
  mode,
}: {
  children: React.ReactNode
  session: { full_name: string }
  mode: CompetitionMode
  periodLabel?: string
}) {
  return (
    <div className="site-shell flex min-h-screen flex-col">
      <SiteHeader mode={mode} account={session.full_name} />
      <main className="content-width flex-1 py-8 sm:py-10">
        {children}
      </main>
      <Footer />
    </div>
  )
}
