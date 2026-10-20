import { pageMetadata } from '@/lib/site'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { autoAssignIfDue } from '@/lib/autoAssign'
import { getSession } from '@/lib/session'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import { loadPickWindow } from '@/lib/pickWindow'
import type { PoolConfig } from '@/lib/competition'
import {
  buildPickPeriods,
  capabilitiesFor,
  formatPeriodDateShort,
  sharedRoundPickQuota,
  type CompetitionMode,
} from '@/lib/competition'
import type { Game } from '@/types'
import PickForm, { type GameRow, type SavedPick } from './PickForm'
import PoolShell from '../components/PoolShell'
import { slateDeadline } from '@/lib/deadline'
import Link from 'next/link'
import { getTeamBrandDirectory, type TeamBrandDirectory } from '@/lib/teamBrand'
import { conferenceGroup, getTeamConferences } from '@/lib/teams'
import { dayDate, pickDayTitle, teamTag, teamTagName, weekdayShort } from '@/lib/poolTheme'
import s from '../components/pp.module.css'

// Room for the auto-assign run this page may kick off after rendering.
export const maxDuration = 60

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
      dayLabel: string
      dateLabel: string
      titleLabel: string
      usedTeams: string[]
      usedList: { team: string; date: string }[]
      gameRows: GameRow[]
      slateId: string
      savedPicks: SavedPick[]
      requiredPicks: number
      sharedRound: boolean
      serverNow: string
      locked: boolean
      teamBrands: TeamBrandDirectory
    }

async function loadPickData(
  playerId: string,
  pool: PoolConfig
): Promise<PickPageData> {
  const mode = pool.competition_mode
  const pickFrequency = pool.pick_frequency
  const caps = capabilitiesFor(mode)
  try {
    const supabase = await getDb()
    const { data: player } = await supabase
      .from('players')
      .select('id, full_name, status, paid')
      .eq('id', playerId)
      .single()
    if (!player) return { kind: 'no-session' }

    const now = await getEffectiveNow()
    // Fill in missed picks once first tip has passed — see lib/autoAssign.ts.
    after(() => autoAssignIfDue(supabase, now))
    const [window, teamBrands] = await Promise.all([
      loadPickWindow(supabase, playerId, pool, now),
      getTeamBrandDirectory(),
    ])
    const slate = window.pickSlate
    if (!slate) return { kind: 'no-slate' }
    const pastPicks = window.picks
    const allSlates = window.seasonSlates
    const allGames: Game[] = window.games

    // Teams burned on previous pick periods — this period's pick isn't "used"
    // while it can still be changed. The date a team was spent travels with
    // it so the board can say *when*: "USED · JAN 18" is the difference
    // between a dead row and a useful one.
    const slateDateById: Record<string, string> = {}
    for (const s of allSlates) slateDateById[s.id] = String(s.slate_date)

    const usedOn: Record<string, string> = {}
    for (const p of pastPicks) {
      if (p.slate_id === slate.id) continue
      usedOn[p.team] = slateDateById[p.slate_id] ?? ''
    }
    const usedTeams = Object.keys(usedOn)

    const gamesData = allGames.filter((game) => game.slate_id === slate.id)

    // Every pick on the slate locks together, at the day's first tip.
    const lockTime = slateDeadline(slate, gamesData)
    const locked = lockTime ? now >= lockTime : false

    const conferences = caps.showRegions ? {} : await getTeamConferences(supabase).catch(() => ({}))
    const usedLabel = (date: string) => (caps.showTournamentRounds ? weekdayShort(date) : formatPeriodDateShort(date))

    const sideOf = (team: string, g: Game, seed: number | null) => ({
      team,
      used: usedTeams.includes(team),
      usedOn: usedOn[team] ? usedLabel(usedOn[team]) : null,
      seed: teamTag(mode, seed, g.round_label),
      rank: null,
      record: null,
    })

    const gameRows: GameRow[] = gamesData.map((g) => ({
      gameId: g.id,
      kickoff: g.tip_time,
      timeTbd: g.time_tbd,
      round: caps.showTournamentRounds ? g.round_label : null,
      region: caps.showRegions ? g.region : null,
      group: caps.showRegions ? g.region : conferenceGroup(g.away_team, g.home_team, conferences),
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
      allSlates.map((s) => ({
        id: s.id,
        slate_number: s.slate_number,
        slate_date: String(s.slate_date),
        locks_at: s.locks_at,
      })),
      allGames.map((g) => ({ slate_id: g.slate_id, round_label: g.round_label }))
    )
    const period = periods.find((p) => p.id === slate.id) ?? null
    const sharedQuota = sharedRoundPickQuota(mode, pickFrequency, period?.round ?? null)
    const periodSlateIds = sharedQuota
      ? new Set(periods.filter((candidate) => candidate.round === period?.round).map((candidate) => candidate.id))
      : new Set([slate.id])
    const savedPicks: SavedPick[] = pastPicks
      .filter((pick) => periodSlateIds.has(pick.slate_id))
      .map((pick) => ({
        id: pick.id,
        team: pick.team,
        slateId: pick.slate_id,
        editable: pick.slate_id === slate.id && !locked,
        autoAssigned: !!pick.auto_assigned,
        updatedAt: pick.updated_at,
      }))

    const dayNumber = Math.max(1, periods.findIndex((p) => p.id === slate.id) + 1)
    const usedList = Object.entries(usedOn)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([team, date]) => ({ team, date: date ? dayDate(date).replace(',', '') : '' }))

    return {
      kind: 'ok',
      playerStatus: player.status,
      periodLabel: period?.label ?? `Slate ${slate.slate_number}`,
      dayLabel: `Day ${dayNumber}`,
      dateLabel: dayDate(String(slate.slate_date)),
      titleLabel: pickDayTitle(period?.round ?? null, String(slate.slate_date), dayNumber),
      usedTeams,
      usedList,
      gameRows,
      slateId: slate.id,
      savedPicks,
      requiredPicks: sharedQuota ?? 1,
      sharedRound: sharedQuota != null,
      locked,
      serverNow: now.toISOString(),
      teamBrands,
    }
  } catch (err) {
    console.error('pick page load failed', err)
    return { kind: 'failed' }
  }
}

export const metadata = pageMetadata('Make Your Pick', 'Sign in to choose your team for the current Pick and Pray survivor pick day.', '/pick', false)

export default async function PickPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const pool = await getPoolConfig()
  const mode: CompetitionMode = pool.competition_mode

  const data = await loadPickData(session.player_id, pool)
  if (data.kind === 'no-session') redirect('/login')

  const brands = data.kind === 'ok' ? data.teamBrands : {}
  const names = Object.fromEntries(Object.entries(brands).map(([abbr, brand]) => [abbr, brand.shortName]))
  const shell = (children: React.ReactNode) => (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session.full_name} names={names}>{children}</PoolShell>
  )

  if (data.kind === 'failed') {
    return shell(<><h1 className={s.title}>Make your pick</h1><p role="alert" className={s.notice}>Failed to load. Try refreshing.</p></>)
  }

  if (data.kind === 'no-slate') {
    return shell(<><h1 className={s.title}>Make your pick</h1><p className={s.notice}>No pick day is open yet. Check back soon.</p></>)
  }

  if (data.playerStatus === 'eliminated') {
    return shell(
      <>
        <div className={s.kicker}>{data.dateLabel} · {data.titleLabel}</div>
        <h1 className={s.title}>Your entry is out</h1>
        <p className={s.notice}>You can still follow the pool on the <Link href="/sweat">sweat board</Link> and <Link href="/#standings">standings</Link>.</p>
      </>
    )
  }

  return shell(
    <PickForm
      key={`${data.slateId}:${data.locked}:${data.savedPicks.map(p => `${p.id}/${p.team}/${p.autoAssigned}`).join(",")}`}
      slateId={data.slateId}
      gameRows={data.gameRows}
      usedTeams={data.usedTeams}
      usedList={data.usedList}
      savedPicks={data.savedPicks}
      requiredPicks={data.requiredPicks}
      sharedRound={data.sharedRound}
      locked={data.locked}
      serverNow={data.serverNow}
      teamBrands={data.teamBrands}
      dayLabel={data.dayLabel}
      dateLabel={data.dateLabel}
      titleLabel={data.titleLabel}
      tagName={teamTagName(mode)}
    />
  )
}
