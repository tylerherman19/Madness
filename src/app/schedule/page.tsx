import SiteHeader from '@/app/components/SiteHeader'
import { getDb } from '@/lib/testMode'
import { getPoolConfig } from '@/lib/pool'
import {
  capabilitiesFor,
  copyFor,
  normalizeRound,
  ROUND_DISPLAY,
  ROUND_SEQUENCE,
  roundOrder,
  seedToShow,
  shortRound,
  type CompetitionMode,
  type TournamentRound,
} from '@/lib/competition'
import { getTeamBrandDirectory, type TeamBrandDirectory } from '@/lib/teamBrand'
import TeamMark from '@/app/components/TeamMark'
import { fetchDayScoreboard, eventCompetitors, toEspnDate, isTimeTbd, parseRound } from '@/lib/espn'

export const revalidate = 3600

// How many days of upcoming games to show. The tournament runs about three
// weeks end to end, so a round-organised schedule needs a much longer horizon
// than a rolling regular-season view.
const REGULAR_SEASON_DAYS_AHEAD = 7
const TOURNAMENT_DAYS_AHEAD = 24

interface ScheduleGame {
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

interface ScheduleDay {
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
  const startOffset = capabilitiesFor(mode).groupScheduleByRound ? 0 : activeDate ? 1 : 0

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

function formatTip(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: CT,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// "January 19" — the secondary line inside a round, where the round name is
// already the heading.
function dayWithin(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export default async function SchedulePage() {
  const pool = await getPoolConfig()
  const mode = pool.competition_mode
  const caps = capabilitiesFor(mode)
  const copy = copyFor(mode)
  const [{ days, season, activeDate }, teamBrands] = await Promise.all([
    getScheduleData(mode),
    getTeamBrandDirectory(),
  ])
  const hasAnyGames = days.some((d) => d.games.length > 0)

  // In the tournament the round is the organising unit and the date is detail
  // inside it. Outside it, the date *is* the unit — college basketball has no
  // weekly rhythm to borrow.
  const rounds = caps.groupScheduleByRound ? groupByRound(days) : []

  return (
    <div className="site-shell flex min-h-screen flex-col">
      <SiteHeader mode={mode} />

      <main className="content-width flex-1 py-9 sm:py-12">
        <div className="max-w-3xl pb-3">
          <p className="text-sm font-bold" style={{ color: 'var(--orange-dark)' }}>Plan your path</p>
          <h1 className="font-display text-5xl leading-none" style={{ color: 'var(--dark)' }}>
            {copy.scheduleHeading}
          </h1>
          <p className="mt-2 text-sm font-semibold" style={{ color: 'var(--muted)' }}>
            {season} {caps.showTournamentRounds ? 'Tournament' : 'Season'}
            {activeDate ? ` · Currently playing ${dayWithin(activeDate)}` : ''}
          </p>
          <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
            Plan ahead — {copy.reuseRule.charAt(0).toLowerCase() + copy.reuseRule.slice(1)}
          </p>
        </div>

        {!hasAnyGames ? (
          <div className="py-20 text-center">
            <p className="font-display text-4xl" style={{ color: 'var(--dark)' }}>SCHEDULE NOT AVAILABLE YET</p>
            <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>
              {caps.showTournamentRounds
                ? 'Rounds appear once the bracket is released and synced.'
                : 'Check back once upcoming game days are synced.'}
            </p>
          </div>
        ) : caps.groupScheduleByRound ? (
          <>
            {/* Round nav. Anchors rather than client-side tabs: the whole
                schedule is one server-rendered document, so every round is
                linkable and shareable. */}
            <nav className="mt-6 flex gap-1.5 flex-wrap" aria-label="Tournament rounds">
              {rounds.map(({ round }) => (
                <a
                  key={round}
                  href={`#${anchorFor(round)}`}
                  className="px-3 py-1.5 text-xs font-bold tracking-wider uppercase"
                  style={{ border: '1px solid var(--border)', color: 'var(--dark)', background: 'var(--surface)', borderRadius: 4 }}
                >
                  {ROUND_DISPLAY[round]}
                </a>
              ))}
            </nav>

            {rounds.map(({ round, days: roundDays }) => (
              <section key={round} id={anchorFor(round)} className="pt-10 scroll-mt-4">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <h2 className="font-display text-4xl leading-none" style={{ color: 'var(--dark)' }}>
                    {ROUND_DISPLAY[round].toUpperCase()}
                  </h2>
                  <span className="eyebrow">
                    {roundDays.reduce((n, d) => n + d.games.length, 0)} games · {roundDays.length}{' '}
                    {roundDays.length === 1 ? 'day' : 'days'}
                  </span>
                </div>
                {roundDays.map((day) => (
                  <div key={day.date} className="pt-5">
                    <p className="eyebrow mb-2">{day.label === 'Today' || day.label === 'Tomorrow' ? `${day.label} · ${dayWithin(day.date)}` : day.label}</p>
                    <GameTable games={day.games} mode={mode} teamBrands={teamBrands} />
                  </div>
                ))}
              </section>
            ))}
          </>
        ) : (
          days.map((day) =>
            day.games.length === 0 ? null : (
              <section key={day.date} className="pt-9">
                <p className="eyebrow mb-1" style={{ color: day.label === 'Today' ? 'var(--red)' : undefined }}>
                  {day.label}
                </p>
                {day.label === 'Today' || day.label === 'Tomorrow' ? (
                  <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>{dayWithin(day.date)}</p>
                ) : null}
                <GameTable games={day.games} mode={mode} teamBrands={teamBrands} />
              </section>
            )
          )
        )}
      </main>
    </div>
  )
}

function anchorFor(round: TournamentRound): string {
  return `round-${shortRound(round).toLowerCase()}`
}

// Collect the days into rounds, in bracket order. A day with no round label
// (a conference tournament game that slipped into the window, say) is left
// out of the round view rather than filed under a round it isn't in.
function groupByRound(days: ScheduleDay[]): { round: TournamentRound; days: ScheduleDay[] }[] {
  const byRound = new Map<TournamentRound, ScheduleDay[]>()
  for (const day of days) {
    const perRound = new Map<TournamentRound, ScheduleGame[]>()
    for (const game of day.games) {
      if (!game.round) continue
      const list = perRound.get(game.round) ?? []
      list.push(game)
      perRound.set(game.round, list)
    }
    for (const [round, games] of perRound) {
      const list = byRound.get(round) ?? []
      list.push({ ...day, games })
      byRound.set(round, list)
    }
  }
  return ROUND_SEQUENCE.filter((r) => byRound.has(r))
    .sort((a, b) => roundOrder(a) - roundOrder(b))
    .map((round) => ({ round, days: byRound.get(round)! }))
}

function GameTable({ games, mode, teamBrands }: { games: ScheduleGame[]; mode: CompetitionMode; teamBrands: TeamBrandDirectory }) {
  const caps = capabilitiesFor(mode)
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              <th className="py-2.5 pl-4 text-left eyebrow">Matchup</th>
              {caps.showRegions && (
                <th className="py-2.5 px-3 text-left eyebrow hidden sm:table-cell whitespace-nowrap">Region</th>
              )}
              <th className="py-2.5 pr-4 text-right eyebrow hidden sm:table-cell whitespace-nowrap">Tip (CT)</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g, i) => {
              const awaySeed = seedToShow(mode, g.awaySeed, g.round)
              const homeSeed = seedToShow(mode, g.homeSeed, g.round)
              const tip = g.timeTbd ? 'TBD' : formatTip(g.kickoff)
              return (
                <tr key={`${g.awayAbbr}@${g.homeAbbr}-${i}`} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-3 pl-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Side abbr={g.awayAbbr} seed={awaySeed} teamBrands={teamBrands} />
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>vs.</span>
                      <Side abbr={g.homeAbbr} seed={homeSeed} teamBrands={teamBrands} />
                    </div>
                    <span className="block sm:hidden text-xs mt-1" style={{ color: 'var(--muted)' }}>
                      {tip}
                      {caps.showRegions && g.region ? ` · ${g.region} Region` : ''}
                    </span>
                  </td>
                  {caps.showRegions && (
                    <td className="py-3 px-3 text-xs hidden sm:table-cell" style={{ color: 'var(--muted)' }}>
                      {g.region ?? '—'}
                    </td>
                  )}
                  <td className="py-3 pr-4 text-right text-xs hidden sm:table-cell tnum" style={{ color: 'var(--muted)' }}>{tip}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Seed ahead of the name, compact and sports-native — not a decorative badge.
function Side({ abbr, seed, teamBrands }: { abbr: string; seed: number | null; teamBrands: TeamBrandDirectory }) {
  return (
    <span className="flex items-center gap-1.5">
      {seed != null && (
        <span className="tnum" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{seed}</span>
      )}
      <TeamMark team={abbr} directory={teamBrands} size={34} showName />
    </span>
  )
}
