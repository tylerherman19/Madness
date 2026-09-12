import SiteHeader from '@/app/components/SiteHeader'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import {
  capabilitiesFor,
  normalizeRound,
  type CompetitionMode,
  type TournamentRound,
} from '@/lib/competition'
import { getTeamBrandDirectory } from '@/lib/teamBrand'
import ScheduleBoard from './ScheduleBoard'
import LiveTicker from '@/app/components/LiveTicker'
import { Footer } from '@/app/components/Sports'
import s from '@/app/components/sports.module.css'
import { fetchDayScoreboard, eventCompetitors, toEspnDate, isTimeTbd, parseRound } from '@/lib/espn'

export const revalidate = 3600

// How many days of upcoming games to show. The tournament runs about three
// weeks end to end, so a round-organised schedule needs a much longer horizon
// than a rolling regular-season view.
const REGULAR_SEASON_DAYS_AHEAD = 7
const TOURNAMENT_DAYS_AHEAD = 24

export interface ScheduleGame {
  homeAbbr: string
  awayAbbr: string
  homeSeed: number | null
  awaySeed: number | null
  kickoff: string // ISO UTC
  // ESPN publishes the season months ahead with placeholder times; until the
  // real tip is announced there is nothing honest to show but "TBD".
  timeTbd: boolean
  round: TournamentRound | null
  region: string | null
  tv: string | null
}

export interface ScheduleDay {
  date: string // YYYY-MM-DD, Central
  label: string
  games: ScheduleGame[]
}

const CT = 'America/Chicago'

function centralDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: CT })
}

// Read the season's synced games straight from the database when they're
// there: those rows carry the seeds, regions and round labels the tournament
// view is built on, which a day-by-day scoreboard scrape would have to
// re-derive. ESPN is the fallback for horizons nobody has synced yet.
async function fetchDbGames(fromDate: string, toDate: string): Promise<Map<string, ScheduleGame[]>> {
  const byDate = new Map<string, ScheduleGame[]>()
  try {
    const supabase = await getDb()
    const { data: slates } = await supabase
      .from('slates')
      .select('id, slate_date')
      .gte('slate_date', fromDate)
      .lte('slate_date', toDate)
    if (!slates?.length) return byDate

    const dateById: Record<string, string> = {}
    for (const s of slates) dateById[s.id] = String(s.slate_date).slice(0, 10)

    const { data: games } = await supabase
      .from('games')
      .select('slate_id, home_team, away_team, home_seed, away_seed, tip_time, time_tbd, round_label, region, tv')
      .in('slate_id', slates.map((s) => s.id))
      .order('tip_time')

    for (const g of games ?? []) {
      const date = dateById[g.slate_id]
      if (!date) continue
      const list = byDate.get(date) ?? []
      list.push({
        homeAbbr: g.home_team,
        awayAbbr: g.away_team,
        homeSeed: g.home_seed,
        awaySeed: g.away_seed,
        kickoff: g.tip_time,
        timeTbd: g.time_tbd,
        round: normalizeRound(g.round_label),
        region: g.region,
        tv: g.tv,
      })
      byDate.set(date, list)
    }
  } catch {
    // No database, or the schedule hasn't been synced — fall back to ESPN.
  }
  return byDate
}

async function fetchEspnDay(day: Date): Promise<ScheduleGame[]> {
  try {
    const { events } = await fetchDayScoreboard(toEspnDate(day), 3600)

    const games: ScheduleGame[] = []
    for (const event of events) {
      const teams = eventCompetitors(event)
      if (!teams) continue
      const homeAbbr = teams.home.team.abbreviation
      const awayAbbr = teams.away.team.abbreviation
      if (!homeAbbr || !awayAbbr) continue
      const { roundLabel, region } = parseRound(event)

      games.push({
        homeAbbr,
        awayAbbr,
        homeSeed: teams.home.curatedRank?.current ?? null,
        awaySeed: teams.away.curatedRank?.current ?? null,
        kickoff: event.date,
        timeTbd: isTimeTbd(event),
        round: normalizeRound(roundLabel),
        region,
        tv: null,
      })
    }
    games.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
    return games
  } catch {
    return []
  }
}

async function getScheduleData(mode: CompetitionMode): Promise<{
  days: ScheduleDay[]
  season: number
  activeDate: string | null
}> {
  let activeDate: string | null = null
  let season = new Date().getFullYear()
  try {
    const supabase = await getDb()
    const { data: slate } = await supabase
      .from('slates')
      .select('slate_date, season_year')
      .eq('is_active', true)
      .single()
    if (slate) {
      activeDate = String(slate.slate_date).slice(0, 10)
      season = slate.season_year
    }
  } catch { /* pool not started yet */ }

  const daysAhead = capabilitiesFor(mode).groupScheduleByRound
    ? TOURNAMENT_DAYS_AHEAD
    : REGULAR_SEASON_DAYS_AHEAD

  // The tournament view includes the day being played — a round is only
  // legible with all of its games on screen. The rolling regular-season view
  // starts tomorrow, because today's board lives on the pick page.
  const anchor = activeDate ? new Date(`${activeDate}T12:00:00Z`) : new Date()
  const startOffset = 0 // Scores now includes the active slate, not only future games.

  const dayDates: Date[] = []
  for (let i = 0; i < daysAhead; i++) {
    dayDates.push(new Date(anchor.getTime() + (i + startOffset) * 86_400_000))
  }
  if (dayDates.length === 0) return { days: [], season, activeDate }

  const dbGames = await fetchDbGames(
    centralDate(dayDates[0]),
    centralDate(dayDates[dayDates.length - 1])
  )

  // Only reach out to ESPN for days the database doesn't already cover.
  const missing = dayDates.filter((d) => !dbGames.has(centralDate(d)))
  const fetched = await Promise.all(missing.map((d) => fetchEspnDay(d)))
  missing.forEach((d, i) => dbGames.set(centralDate(d), fetched[i]))

  const todayCentral = centralDate(new Date())
  const tomorrowCentral = centralDate(new Date(Date.now() + 86_400_000))

  const days: ScheduleDay[] = dayDates.map((d) => {
    const date = centralDate(d)
    const label =
      date === todayCentral
        ? 'Today'
        : date === tomorrowCentral
        ? 'Tomorrow'
        : d.toLocaleDateString('en-US', { timeZone: CT, weekday: 'long', month: 'long', day: 'numeric' })
    return { date, label, games: (dbGames.get(date) ?? []).slice().sort(byTip) }
  })

  return { days, season, activeDate }
}

function byTip(a: ScheduleGame, b: ScheduleGame): number {
  if (a.timeTbd !== b.timeTbd) return a.timeTbd ? 1 : -1
  return new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()
}

export default async function SchedulePage(){
 const pool=await getPoolConfig()
 const [{days,season},teamBrands]=await Promise.all([getScheduleData(pool.competition_mode),getTeamBrandDirectory()])
 return <div className={s.root}><SiteHeader mode={pool.competition_mode}/><LiveTicker/><main className={s.main}><ScheduleBoard days={days} season={season} brands={teamBrands}/></main><Footer/></div>
}
