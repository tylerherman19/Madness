import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Script the fake ESPN scoreboard the app process sees (tests/support/upstream.mjs).
const file = () => join(tmpdir(), `madness-fake-espn-${process.env.E2E_DB_PORT ?? '54329'}.json`)
export const setEspn = (days: Record<string, unknown[]>) => writeFileSync(file(), JSON.stringify(days))
export const clearEspn = () => rmSync(file(), { force: true })

export function espnEvent(id: string, date: string, home: [string, string, string?], away: [string, string, string?], final = false) {
  const side = (homeAway: string, [abbreviation, teamId, score]: [string, string, string?]) => ({
    homeAway, score, winner: final ? Number(score) > Number((homeAway === 'home' ? away : home)[2]) : undefined,
    team: { id: teamId, abbreviation, displayName: abbreviation, shortDisplayName: abbreviation },
  })
  return { id, date, competitions: [{ timeValid: true, status: { type: final
    ? { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final' }
    : { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '1:00 PM' } },
    competitors: [side('home', home), side('away', away)] }] }
}
