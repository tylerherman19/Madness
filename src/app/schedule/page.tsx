import Link from 'next/link'
import LogoMark from '@/app/components/LogoMark'
import { getDb } from '@/lib/testMode'
import { teamColor } from '@/lib/teamColors'
import { fetchDayScoreboard, eventCompetitors, toEspnDate } from '@/lib/espn'

export const revalidate = 3600

// How many days of upcoming games to show.
const DAYS_AHEAD = 5

interface ScheduleGame {
  homeAbbr: string
  awayAbbr: string
  kickoff: string // ISO UTC
}

interface ScheduleDay {
  date: string // YYYY-MM-DD, Central
  label: string
  games: ScheduleGame[]
}

async function fetchDayGames(day: Date): Promise<ScheduleGame[]> {
  try {
    const { events } = await fetchDayScoreboard(toEspnDate(day), 3600)

    const games: ScheduleGame[] = []
    for (const event of events) {
      const teams = eventCompetitors(event)
      if (!teams) continue
      const homeAbbr = teams.home.team.abbreviation
      const awayAbbr = teams.away.team.abbreviation
      if (!homeAbbr || !awayAbbr) continue

      games.push({ homeAbbr, awayAbbr, kickoff: event.date })
    }
    games.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
    return games
  } catch {
    return []
  }
}

async function getScheduleData(): Promise<{
  days: ScheduleDay[]
  season: number
  activeDate: string | null
}> {
  let activeDate: string | null = null
  let season = 2026
  try {
    const supabase = await getDb()
    const { data: slate } = await supabase
      .from('slates')
      .select('slate_date, season_year')
      .eq('is_active', true)
      .single()
    if (slate) {
      activeDate = String(slate.slate_date)
      season = slate.season_year
    }
  } catch { /* pool not started yet */ }

  // Start from the day after the active slate, or today if the pool hasn't
  // started. Dark days are kept in the list and simply render as empty.
  const start = activeDate
    ? new Date(new Date(`${activeDate}T12:00:00Z`).getTime() + 86_400_000)
    : new Date()

  const dayDates: Date[] = []
  for (let i = 0; i < DAYS_AHEAD; i++) {
    dayDates.push(new Date(start.getTime() + i * 86_400_000))
  }

  const results = await Promise.all(dayDates.map((d) => fetchDayGames(d)))
  const days: ScheduleDay[] = dayDates.map((d, i) => ({
    date: d.toISOString().slice(0, 10),
    label: d.toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }),
    games: results[i],
  }))
  return { days, season, activeDate }
}

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export default async function SchedulePage() {
  const { days, season, activeDate } = await getScheduleData()
  const hasAnyGames = days.some((d) => d.games.length > 0)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--cream)' }}>
      <header style={{ background: 'var(--dark)' }}>
        <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 font-display text-white text-xl tracking-wider">
            <LogoMark size={64} />
            NFL SURVIVOR
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-xs tracking-widest uppercase text-gray-400 hover:text-white transition-colors">Standings</Link>
            <Link href="/login" className="text-xs tracking-widest uppercase text-gray-400 hover:text-white transition-colors">Log In</Link>
            <Link
              href="/pick"
              className="btn-primary font-display text-sm tracking-wider px-4 py-2"
            >
              SUBMIT PICK
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-10">
        <div className="pb-2">
          <h1 className="font-display text-6xl sm:text-7xl leading-none" style={{ color: 'var(--dark)' }}>
            UPCOMING SCHEDULE
          </h1>
          <p className="mt-2 eyebrow">
            {season} Season{activeDate ? ` · Currently playing ${activeDate}` : ''}
          </p>
          <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
            Plan ahead — you can only use each team once.
          </p>
        </div>

        {!hasAnyGames ? (
          <div className="py-20 text-center">
            <p className="font-display text-4xl" style={{ color: 'var(--dark)' }}>SCHEDULE NOT AVAILABLE YET</p>
            <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>Check back once the league releases upcoming slates.</p>
          </div>
        ) : (
          days.map(({ date, label, games }) =>
            games.length === 0 ? null : (
              <section key={date} className="pt-9">
                <p className="eyebrow mb-3">{label}</p>
                <div className="card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: 'var(--surface-sunken)' }}>
                        <th className="py-2.5 pl-4 text-left eyebrow">Matchup</th>
                        <th className="py-2.5 pr-4 text-right eyebrow hidden sm:table-cell">Tip (CT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {games.map((g) => (
                        <tr key={`${g.awayAbbr}@${g.homeAbbr}`} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                          <td className="py-3 pl-4">
                            <div className="flex items-center gap-2">
                              <span className="team-chip-swatch" style={{ background: teamColor(g.awayAbbr).primary }}>{g.awayAbbr.slice(0, 3)}</span>
                              <span className="font-bold" style={{ color: 'var(--dark)' }}>{g.awayAbbr}</span>
                              <span className="text-xs" style={{ color: 'var(--muted)' }}>@</span>
                              <span className="team-chip-swatch" style={{ background: teamColor(g.homeAbbr).primary }}>{g.homeAbbr.slice(0, 3)}</span>
                              <span className="font-bold" style={{ color: 'var(--dark)' }}>{g.homeAbbr}</span>
                            </div>
                            <span className="block sm:hidden text-xs mt-1" style={{ color: 'var(--muted)' }}>{formatKickoff(g.kickoff)}</span>
                          </td>
                          <td className="py-3 pr-4 text-right text-xs hidden sm:table-cell tnum" style={{ color: 'var(--muted)' }}>{formatKickoff(g.kickoff)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          )
        )}
      </main>
    </div>
  )
}
