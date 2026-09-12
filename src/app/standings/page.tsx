import Link from 'next/link'
import type { StandingRow } from '@/types'

import { getPoolConfig } from '@/lib/pool'
import {
  capabilitiesFor,
  copyFor,
  formatPeriodDate,
  type CompetitionMode,
} from '@/lib/competition'
import LiveTicker from '../components/LiveTicker'
import SiteHeader from '../components/SiteHeader'
import TeamChip from '../components/TeamChip'

import {
  BurnMap,
  ChalkFigure,
  ExposureFigure,
  LeverageTable,
  OverlapFigure,
  Story,
  TrajectoryFigure,
} from '../components/insights'

import { getDashboardData } from '@/lib/dashboard'
export const revalidate = 60

export default async function DashboardPage() {
  const { haveSignupsClosed } = await import('@/lib/season')
  const [data, signupsClosed] = await Promise.all([getDashboardData(), haveSignupsClosed()])

  const aliveRows = data?.standings.filter((r) => r.status === 'alive') ?? []
  const elimRows = data?.standings.filter((r) => r.status === 'eliminated') ?? []
  const insights = data?.insights

  // One read of the pool's format, threaded through the whole page. If the
  // dashboard query failed we still need a mode to render the header with.
  const mode: CompetitionMode = data?.mode ?? (await getPoolConfig()).competition_mode
  const copy = copyFor(mode)
  const period = data?.currentPeriod ?? null

  const rules = buildRules(mode, copy, data?.pool?.tiebreaker ?? 'seed-total')

  // The editorial figures label their x-axis with pick periods, not week
  // numbers — the same vocabulary the rest of the page uses.
  const periodLabels: Record<number, string> = {}
  for (const p of data?.periods ?? []) periodLabels[p.number] = p.shortLabel

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

          {insights?.leverage && (
            <Story
              kicker="Leverage"
              lede={insights.leverage.headline}
              deck={insights.leverage.deck}
              method="Best case is the field that would remain if this pick wins and every other public pick loses. Dollar figures split the current pot across that field."
            >
              <LeverageTable data={insights.leverage} />
            </Story>
          )}

          {/* ---- Standings ---- */}
          <Section id="standings" title="Standings" className="pt-10">
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    <th className="py-2.5 pl-4 text-left eyebrow w-full">Player</th>
                    <th className="py-2.5 px-4 text-left eyebrow hidden sm:table-cell whitespace-nowrap">Status</th>
                    <th className="py-2.5 pl-4 pr-4 text-left eyebrow whitespace-nowrap">{data.currentPeriod ? `${data.currentPeriod.shortLabel} Pick` : 'Pick'}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.totalPlayers === 0 && <tr><td colSpan={3} className="p-8 text-center"><strong className="block mb-2">The field is open</strong><p className="text-sm text-[var(--muted)] mb-4">Players will appear here when they join the pool.</p>{!signupsClosed && <Link href="/signup" className="btn-primary px-5">Join the pool</Link>}</td></tr>}
                  {aliveRows.length > 0 && (
                    <tr>
                      <td colSpan={3} className="pt-4 pb-1.5 pl-4">
                        <span className="pill pill-alive"><span className="pill-dot" />{aliveRows.length} Still Alive</span>
                      </td>
                    </tr>
                  )}
                  {aliveRows.map((row) => (
                    <tr key={row.player_id} className="row-hover border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="py-3 pl-4 font-bold" style={{ color: 'var(--dark)' }}>{row.full_name}</td>
                      <td className="py-3 px-4 hidden sm:table-cell">
                        <span className="pill pill-alive"><span className="pill-dot" />Alive</span>
                      </td>
                      <td className="py-3 pl-4 pr-4">
                        {row.current_pick ? (
                          row.pick_revealed ? (
                            <TeamChip team={row.current_pick} size={28} directory={data.teamBrands} />
                          ) : (
                            <span className="pill pill-alive">✓ Pick In</span>
                          )
                        ) : (
                          <span className="text-xs italic" style={{ color: 'var(--red)' }}>no pick yet</span>
                        )}
                      </td>
                    </tr>
                  ))}

                  {elimRows.length > 0 && (
                    <tr>
                      <td colSpan={3} className="pt-6 pb-1.5 pl-4">
                        <span className="pill pill-out">♦ {elimRows.length} Eliminated</span>
                      </td>
                    </tr>
                  )}
                  {elimRows.map((row) => {
                    const ew = (row as StandingRow & { elimination_slate?: number | null }).elimination_slate
                    return (
                      <tr key={row.player_id} className="border-t" style={{ borderColor: 'var(--border)', opacity: 0.65 }}>
                        <td className="py-2.5 pl-4 text-sm" style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{row.full_name}</td>
                        <td className="py-2.5 px-4 hidden sm:table-cell">
                          <span className="pill pill-out">Out{ew ? ` · ${data.periodByNumber[ew]?.shortLabel ?? `#${ew}`}` : ''}</span>
                        </td>
                        <td className="py-2.5 pl-4 pr-4 text-xs" style={{ color: 'var(--muted)' }}>
                          {row.elimination_reason ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ---- The season so far ---- */}
          {(insights?.trajectory || insights?.chalk || insights?.scarcity || insights?.overlap) && (
            <div className="pt-12">
              <hr className="story-rule" />
              <p className="eyebrow mt-4">The season so far</p>
            </div>
          )}

          {insights?.trajectory && (
            <Story
              kicker="Attrition"
              lede={insights.trajectory.headline}
              deck={insights.trajectory.deck}
              method="The dashed projection compounds the season's average weekly survival rate forward. It is an extrapolation of this pool's own results, not a forecast of any game."
            >
              <TrajectoryFigure data={insights.trajectory} periodLabels={periodLabels} />
            </Story>
          )}

          {insights?.chalk && (
            <Story
              kicker="The crowd"
              lede={insights.chalk.headline}
              deck={insights.chalk.deck}
              method="The crowd pick is the most-selected team in a completed slate, across every entry that was still alive to make one."
            >
              <ChalkFigure data={insights.chalk} periodLabels={periodLabels} />
            </Story>
          )}

          {insights?.scarcity && (
            <Story
              kicker="What's left on the board"
              lede={insights.scarcity.headline}
              deck={insights.scarcity.deck}
              method="Counts cover surviving entries only. A team is spent for a player the moment their pick on it locks — you can't pick the same team twice all season."
            >
              <BurnMap data={insights.scarcity} />
            </Story>
          )}

          {insights?.overlap && (
            <Story
              kicker="Divergence"
              lede={insights.overlap.headline}
              deck={insights.overlap.deck}
              method="Overlap is the share of two survivors' unused teams that is common to both. Boards that overlap heavily tend to live and die together in later slates."
            >
              <OverlapFigure data={insights.overlap} />
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

      {/* Footer */}
      <footer style={{ background: 'var(--dark)' }} className="mt-10">
        <div className="content-width py-7 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400">$25 entry · Venmo @griffinsell</span>
          <div className="flex items-center gap-6">
            {!signupsClosed && (
              <Link href="/signup" className="text-xs font-semibold text-gray-400 hover:text-white transition-colors">Join pool</Link>
            )}
            <Link href="/admin/login" className="text-xs font-semibold text-gray-400 hover:text-white transition-colors">Admin</Link>
          </div>
        </div>
      </footer>
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
