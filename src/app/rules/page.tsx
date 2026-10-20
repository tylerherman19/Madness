import { pageMetadata } from '@/lib/site'
import { getPoolConfig } from '@/lib/pool'
import { getDashboardData } from '@/lib/dashboard'
import { getSession } from '@/lib/session'
import { haveSignupsClosed } from '@/lib/season'
import { capabilitiesFor, type PoolConfig } from '@/lib/competition'
import { buildTimeline } from '@/lib/timeline'
import { eventLabel, teamTagName } from '@/lib/poolTheme'
import PoolShell from '../components/PoolShell'
import s from '../components/pp.module.css'

export const dynamic = 'force-dynamic'

export const metadata = pageMetadata('Rules', 'How the Pick and Pray survivor pool works: one pick a day, win and advance, lose and you are out.', '/rules', true)

// The house rules, phrased from the pool's stored configuration so they always
// match what the server enforces.
function rulesFor(pool: PoolConfig): { title: string; text: string }[] {
  const tournament = capabilitiesFor(pool.competition_mode).showTournamentRounds
  const onePick =
    tournament && pool.pick_frequency === 'tournament-round'
      ? 'Each round has a set number of picks. Spend them across that round’s days.'
      : tournament
        ? 'Every pick day, each entry picks exactly one team. In the Elite Eight, make two picks across the round.'
        : 'Every pick day, each entry picks exactly one team.'
  const reuse =
    pool.team_reuse_rule === 'unlimited'
      ? 'You can use the same team more than once.'
      : pool.team_reuse_rule === 'once-per-round'
        ? 'Each team can be used once per round.'
        : 'Each team can be used once per entry.'
  const missed =
    pool.auto_pick_behavior === 'eliminate'
      ? 'Your entry is eliminated.'
      : pool.auto_pick_behavior === 'none'
        ? 'No pick is recorded for that day.'
        : pool.auto_pick_behavior === 'highest-seed' && tournament
          ? 'You are given the highest seed you have not used.'
          : 'You are given an unused team from the last game of the day. If none is left, your entry is out.'
  const endgame =
    pool.tiebreaker === 'seed-total'
      ? tournament
        ? 'The final surviving entry wins. If more than one survives, the highest total of seeds picked wins.'
        : 'The final surviving entry wins. If everyone left loses on the same day, they share the win.'
      : pool.tiebreaker === 'most-survived'
        ? 'The final surviving entry wins. If more than one survives, the entry that lasted longest wins.'
        : 'The final surviving entry wins. If everyone left loses on the same day, they share the win.'
  return [
    { title: 'One pick a day', text: onePick },
    { title: 'Win and advance', text: 'If your team wins, you survive and pick again on the next pick day.' },
    { title: 'Lose and you’re out', text: 'If your team loses, your entry is eliminated for the rest of the pool.' },
    { title: 'Picks stay hidden', text: 'Nobody can see anyone else’s pick until the first game of the day tips off.' },
    { title: 'Change until lock', text: 'You can change your pick as many times as you like before the first tip. Only your last submitted pick counts.' },
    { title: 'No repeats', text: reuse },
    { title: 'Missed the lock', text: missed },
    { title: 'Last one standing', text: endgame },
  ]
}

const STEPS = [
  { label: 'Pick', text: 'Choose one team playing that day.' },
  { label: 'Lock', text: 'Picks lock at the first tip.' },
  { label: 'Reveal', text: 'Everyone’s picks appear on the sweat board.' },
  { label: 'Win', text: 'Your team wins. You play the next day.', tone: 'green' },
  { label: 'Lose', text: 'Your team loses. Your entry is out.', tone: 'red' },
]

export default async function RulesPage() {
  const [data, session, closed] = await Promise.all([getDashboardData(), getSession(), haveSignupsClosed()])
  const pool = data?.pool ?? (await getPoolConfig())
  const mode = pool.competition_mode
  const tournament = capabilitiesFor(mode).showTournamentRounds
  const names = Object.fromEntries(Object.entries(data?.teamBrands ?? {}).map(([abbr, brand]) => [abbr, brand.shortName]))
  const days = buildTimeline({
    periods: data?.periods ?? [],
    currentId: data?.slate?.id ?? null,
    totalEntries: 0,
    aliveCount: 0,
    eliminatedBySlate: new Map(),
    tournament,
    maxColumns: tournament ? 16 : 12,
  }).filter((day) => day.key !== 'start')
  const totalDays = tournament ? days.length : (data?.periods.length ?? 0)
  const rules = rulesFor(pool)
  const facts = [
    { label: 'Format', value: tournament ? 'March Madness' : 'Regular season' },
    ...(totalDays ? [{ label: 'Pick days', value: String(totalDays) }] : []),
    { label: 'Entries', value: String(data?.totalPlayers ?? 0) },
    { label: 'Picks lock', value: pool.pick_deadline_rule === 'per-game' ? 'At each game’s tip' : 'First tip each day' },
    { label: 'Picks revealed', value: 'At lock' },
    { label: 'Team labels', value: teamTagName(mode) === 'seed' ? 'Seed' : 'AP rank' },
    {
      label: 'Missed pick',
      value:
        pool.auto_pick_behavior === 'eliminate' ? 'Entry is out'
          : pool.auto_pick_behavior === 'none' ? 'No pick recorded'
            : pool.auto_pick_behavior === 'highest-seed' && tournament ? 'Highest unused seed'
              : 'Unused team from the last game',
    },
    { label: 'Entry', value: '$25 via Venmo to @griffinsell' },
  ]

  return (
    <PoolShell mode={mode} seasonYear={pool.season_year} account={session?.full_name} signupsClosed={closed} names={names} width="mid">
      <div className={s.kicker}>{eventLabel(mode, pool.season_year)}</div>
      <h1 className={s.title}>Rules</h1>

      <ol className={s.stepList} aria-label="Every pick day">
        {STEPS.map((step, index) => (
          <li key={step.label}>
            <small>Step {index + 1}</small>
            <b className={step.tone === 'green' ? s.green : step.tone === 'red' ? s.red : undefined}>{step.label}</b>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>

      <div className={s.rulesGrid}>
        <article>
          <h2 className={s.rulesHeading}>The rules</h2>
          <ol className={s.ruleList}>
            {rules.map((rule, index) => (
              <li key={rule.title}>
                <span>{index + 1}</span>
                <div><h2>{rule.title}</h2><p>{rule.text}</p></div>
              </li>
            ))}
          </ol>

          {days.length > 0 && (
            <section className={s.dayBlock}>
              <h2>Pick days</h2>
              <div className={s.days}>
                {days.map((day) => (
                  <div className={s.day} data-today={day.state === 'today'} key={day.key}>{day.label}<span>{day.date}</span></div>
                ))}
              </div>
              <ul className={s.notes}>
                {tournament ? (
                  <>
                    <li>Every day with tournament games is a pick day, through the title game.</li>
                    <li>Seeds are shown next to each team.</li>
                  </>
                ) : (
                  <>
                    <li>Every day with games on the pool schedule is a pick day.</li>
                    <li>AP top-25 ranks are shown next to each team.</li>
                  </>
                )}
              </ul>
            </section>
          )}
        </article>

        <aside className={`${s.aside} ${s.facts}`} aria-label="This pool">
          <h2>This pool</h2>
          <dl>
            {facts.map((fact) => (
              <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
            ))}
          </dl>
        </aside>
      </div>
    </PoolShell>
  )
}
