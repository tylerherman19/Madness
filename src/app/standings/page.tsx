import Link from 'next/link'

import { getPoolConfig } from '@/lib/pool'
import {
  capabilitiesFor,
  copyFor,
  formatPeriodDate,
  type CompetitionMode,
} from '@/lib/competition'
import LiveTicker from '../components/LiveTicker'
import SiteHeader from '../components/SiteHeader'
import StandingsTable from '../components/StandingsTable'
import TeamChip from '../components/TeamChip'
import { Footer } from '../components/Sports'

import {
  BurnMap,
  ExposureFigure,
  Story,
} from '../components/insights'

import { getDashboardData } from '@/lib/dashboard'
export const revalidate = 60

export default async function DashboardPage() {
  const { haveSignupsClosed } = await import('@/lib/season')
  const [data, signupsClosed] = await Promise.all([getDashboardData(), haveSignupsClosed()])

  const aliveRows = data?.standings.filter((r) => r.status === 'alive') ?? []
  const elimRows = data?.standings.filter((r) => r.status === 'eliminated') ?? []
  const clientAliveRows = aliveRows.map((row) => ({
    ...row,
    current_pick: row.pick_revealed ? row.current_pick : null,
  }))
  const insights = data?.insights

  // One read of the pool's format, threaded through the whole page. If the
  // dashboard query failed we still need a mode to render the header with.
  const mode: CompetitionMode = data?.mode ?? (await getPoolConfig()).competition_mode
  const copy = copyFor(mode)
  const period = data?.currentPeriod ?? null

  const rules = buildRules(mode, copy, data?.pool?.tiebreaker ?? 'seed-total')

  return (
    <div className="site-shell">
      {/* Header */}
      <SiteHeader signupsClosed={signupsClosed} mode={mode} />

      {/* Live scores ticker — client component, polls independently of cached server render */}
      <LiveTicker
        slateNumber={data?.slate?.slate_number}
        season={data?.slate?.season_year}
        label={period?.roundLabel ?? (period ? formatPeriodDate(period.date) : null)}
      />

      {data && data.aliveCount === 1 && aliveRows.length === 1 && (
        <div style={{ background: 'var(--dark)', borderBottom: '4px solid var(--green)' }}>
          <div className="content-width py-10 text-center">
            <p className="eyebrow mb-2" style={{ color: 'var(--green)' }}>Survivor Champion</p>
            <p className="font-display text-7xl sm:text-8xl" style={{ color: 'var(--cream)' }}>{aliveRows[0].full_name.toUpperCase()}</p>
            <p className="mt-3 eyebrow" style={{ color: 'var(--green)' }}>Winner Takes ${data.potSize}</p>
          </div>
        </div>
      )}

      {!data ? (
        <main className="content-width py-24 text-center">
          <p className="font-display text-6xl" style={{ color: 'var(--dark)' }}>The court is being set</p>
          <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>The pool will appear here when the first game day is ready.</p>
        </main>
      ) : (
        <main className="content-width dashboard-content pb-4">
          <div className="workspace-heading"><div><h1>Standings</h1><p>The field, every pick, and your season in numbers.</p></div><Link href="/grid" className="btn-secondary px-4">Full pick grid</Link></div>
          {insights?.exposure && (
            <section className="pt-10">
              <ExposureFigure data={insights.exposure} />
            </section>
          )}

          {/* ---- Standings ---- */}
          <Section id="standings" title="Standings" className="pt-10">
            <StandingsTable
              aliveRows={clientAliveRows}
              elimRows={elimRows}
              periodLabel={data.currentPeriod?.shortLabel ?? null}
              periodByNumber={data.periodByNumber}
              teamBrands={data.teamBrands}
              signupsClosed={signupsClosed}
            />
          </Section>

          {/* ---- The season so far ---- */}
          {insights?.scarcity && (
            <div className="pt-12">
              <hr className="story-rule" />
              <p className="eyebrow mt-4">The season so far</p>
            </div>
          )}

          {insights?.scarcity && (
            <Story
              kicker="What's left on the board"
              method="Counts cover surviving entries only. A team is spent for a player the moment their pick on it locks — you can't pick the same team twice all season."
            >
              <BurnMap data={insights.scarcity} />
            </Story>
          )}

          {/* Team ledger — how each team has actually treated the people who picked it */}
          {data.teamStats.length > 0 && (
            <Section title="Team ledger">
              <div className="card overflow-hidden">
                {/* Every cell carries its own horizontal padding: .eyebrow's 0.18em
                    tracking makes these headers wide enough that with no gap they
                    ran together into one "TEAM TIMES PICKED WIN RATE ELIMINATIONS"
                    string on a phone. Short labels keep four tracked columns inside
                    a 390px viewport, and the numeric columns are right-aligned so
                    the figures sit under their own header instead of hugging the
                    column to their left. */}
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--surface-sunken)' }}>
                      <th className="py-2.5 pl-4 pr-3 text-left eyebrow">Team</th>
                      <th className="py-2.5 px-3 text-right eyebrow whitespace-nowrap">Picks</th>
                      <th className="py-2.5 px-3 text-right eyebrow whitespace-nowrap">Win Rate</th>
                      <th className="py-2.5 pl-3 pr-4 text-right eyebrow whitespace-nowrap">Outs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.teamStats.map((stat) => (
                      <tr key={stat.team} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                        <td className="py-2.5 pl-4 pr-3"><TeamChip team={stat.team} showName size={30} directory={data.teamBrands} /></td>
                        <td className="py-2.5 px-3 text-right tnum" style={{ color: 'var(--dark)' }}>{stat.times_picked}</td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 rounded-full overflow-hidden hidden sm:block" style={{ background: 'var(--surface-sunken)', height: 6 }}>
                              <div className="h-full rounded-full" style={{ width: `${stat.win_rate * 100}%`, background: stat.win_rate >= 0.6 ? 'var(--green)' : stat.win_rate >= 0.4 ? 'var(--dark)' : 'var(--red)' }} />
                            </div>
                            <span className="font-semibold tnum" style={{ color: stat.win_rate >= 0.6 ? 'var(--green)' : stat.win_rate >= 0.4 ? 'var(--dark)' : 'var(--red)' }}>
                              {(stat.win_rate * 100).toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 pl-3 pr-4 text-right tnum" style={{ color: 'var(--dark)' }}>{stat.eliminations_caused}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="method">Completed slates only. Win rate is how often a team delivered for the people who picked it; Outs is how many entries it ended.</p>
            </Section>
          )}

          {/* Rules */}
          <Section id="rules" title="How It Works">
            <div className="card p-5 sm:p-6 grid sm:grid-cols-2 gap-x-10 gap-y-4">
              {rules.map((text, i) => (
                <Rule key={i} n={String(i + 1)} text={text} />
              ))}
            </div>
          </Section>
        </main>
      )}

      <Footer />
    </div>
  )
}

function Section({ id, title, children, className }: { id?: string; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`pt-10 ${className ?? ''}`}>
      <div className="section-heading mb-3"><h2>{title}</h2></div>
      {children}
    </section>
  )
}

function Rule({ n, text }: { n: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex items-center justify-center shrink-0 rounded-full font-bold text-xs" style={{ background: 'var(--red-tint)', color: 'var(--red)', width: 22, height: 22 }}>{n}</span>
      <span className="text-sm pt-0.5" style={{ color: 'var(--dark)' }}>{text}</span>
    </div>
  )
}


// House rules, phrased for the competition actually being played and for the
// tiebreak the administrator configured. A regular-season pool never mentions
// seeds; a tournament pool never claims "all season".
function buildRules(
  mode: CompetitionMode,
  copy: ReturnType<typeof copyFor>,
  tiebreaker: string
): string[] {
  const tournament = capabilitiesFor(mode).showTournamentRounds

  const endgame =
    tiebreaker === 'most-survived'
      ? 'Last one standing wins. If more than one survives, the entry that lasted longest takes it.'
      : tiebreaker === 'none'
      ? 'Last one standing wins. If more than one survives, they split the pot.'
      : tournament
      ? copy.endgameRule
      : 'Last one standing wins.'

  return [
    'Pay $25 entry via Venmo to @griffinsell.',
    tournament
      ? 'Every tournament game day, pick one team to win.'
      : 'Every day there are games, pick one team to win.',
    copy.reuseRule,
    "Your team wins, you survive. Loses and you're out.",
    'Picks lock when the first game of the day tips off — all of them, at once.',
    "Miss the lock and you're auto-assigned a team from the day's last game. If every team on the slate is already used, you're eliminated.",
    endgame,
  ]
}
