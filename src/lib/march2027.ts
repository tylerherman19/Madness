import type { PoolConfig, TournamentRound } from './competition'

export const MARCH_2027_START = '2027-03-18'
export const ELITE_2027_SATURDAY = '2027-03-27'
export const ELITE_2027_SUNDAY = '2027-03-28'

export const MARCH_2027_DAYS: Readonly<Record<string, TournamentRound>> = {
  [MARCH_2027_START]: '1st Round', '2027-03-19': '1st Round',
  '2027-03-20': '2nd Round', '2027-03-21': '2nd Round',
  '2027-03-25': 'Sweet 16', '2027-03-26': 'Sweet 16',
  [ELITE_2027_SATURDAY]: 'Elite 8', [ELITE_2027_SUNDAY]: 'Elite 8',
  '2027-04-03': 'Final Four', '2027-04-05': 'National Championship',
}

export function isMarch2027(pool: Pick<PoolConfig, 'season_year' | 'competition_mode'>) {
  return pool.season_year === 2027 && pool.competition_mode === 'march-madness'
}

export function isElite2027Date(date: string) {
  return date === ELITE_2027_SATURDAY || date === ELITE_2027_SUNDAY
}

export const MARCH_2027_RULES = [
  { title: 'Registration', text: 'One entry per person. Register on Pick and Pray. The entry fee is $25.' },
  { title: 'Opening day', text: 'The pool begins Thursday, March 18, 2027, with the Round of 64. The March 16–17 Opening Round is outside the pool; its winners are eligible in the Round of 64.' },
  { title: 'One pick per day', text: 'Choose one team playing that day before its first game tips (usually noon Eastern). A win advances you; a loss eliminates you. You can use each team only once in the tournament.' },
  { title: 'Elite Eight', text: 'Pick two teams total from March 27–28. Both picks may be on the same day. Both are due before Saturday’s first tip, and both teams must win.' },
  { title: 'Missed deadline', text: 'You get the best eligible seed, starting at No. 1. AP rank breaks ties on a seed line. If you have no eligible team left, you are eliminated.' },
  { title: 'Winner and tiebreaker', text: 'The last player standing wins the full pot. If multiple players survive the Championship, or all remaining players go out on the same day, the highest sum of seeds from winning picks wins. The pot is split only among entries tied for that highest total.' },
  { title: 'Playing dates', text: 'Round of 64: March 18–19. Round of 32: March 20–21. Sweet 16: March 25–26. Elite Eight: March 27–28. Final Four: April 3. Championship: April 5.' },
  { title: 'Updates', text: 'Look for daily email updates after the games. Contact Griffin Sell at griffin.sell@icloud.com for questions or to join GroupMe.' },
]

export function elite2027Window<T extends { id: string; slate_date: string; locks_at?: string | null }>(
  pool: Pick<PoolConfig, 'season_year' | 'competition_mode'>,
  date: string,
  slates: T[],
) {
  if (!isMarch2027(pool) || !isElite2027Date(date)) return null
  const days = slates.filter(d => isElite2027Date(d.slate_date))
  return { saturday: days.find(d => d.slate_date === ELITE_2027_SATURDAY), ids: new Set(days.map(d => d.id)) }
}
