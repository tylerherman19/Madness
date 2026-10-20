import { capabilitiesFor, type PoolConfig } from '@/lib/competition'
import s from './pp.module.css'

// The house rules, phrased from the pool's stored configuration so they always
// match what the server enforces.
function rulesFor(pool: PoolConfig): { title: string; text: string }[] {
  const tournament = capabilitiesFor(pool.competition_mode).showTournamentRounds
  const onePick =
    tournament && pool.pick_frequency === 'tournament-round'
      ? 'Each round has a set number of picks. Spend them across that round’s days.'
      : tournament
        ? 'Every pick day, each entry picks one team. In the Elite Eight, make two picks across the round.'
        : 'Every pick day, each entry picks one team.'
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
    { title: 'Entry fee', text: '$25 per entry. Pay by Venmo to @griffinsell.' },
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


// The pool rules, shown at the bottom of the Today page.
export default function RulesSection({ pool }: { pool: PoolConfig }) {
  const rules = rulesFor(pool)
  return (
    <section id="rules" className={s.rulesSection} aria-label="Rules">
      <div className={s.sectionHead}><h2>Rules</h2></div>
      <ol className={s.ruleList}>
        {rules.map((rule, index) => (
          <li key={rule.title}>
            <span>{index + 1}</span>
            <div><h2>{rule.title}</h2><p>{rule.text}</p></div>
          </li>
        ))}
      </ol>
    </section>
  )
}
