import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// espn.ts is server-only; load it the way the other route tests do.
type Espn = {
  resultOf: (event: unknown) => string
  displayStateOf: (event: unknown) => string
  scheduledEventSides: (stored: unknown, event: unknown) => { flipped: boolean; home: { team: { abbreviation: string } } } | null
}
const espn: Partial<Espn> = {}
new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('./espn.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)((name: string) => {
  assert.equal(name, 'server-only')
  return {}
}, espn)
const { resultOf, displayStateOf, scheduledEventSides } = espn as Espn

type Side = { score?: string; winner?: boolean | null; id?: string; abbr?: string }
function event(type: Record<string, unknown>, home: Side = {}, away: Side = {}, neutralSite = false) {
  return {
    id: 'e1', date: '2026-01-24T18:00:00Z',
    competitions: [{
      neutralSite,
      status: { type },
      competitors: [
        { homeAway: 'home', score: home.score, winner: home.winner, team: { id: home.id ?? '1', abbreviation: home.abbr ?? 'HOME' } },
        { homeAway: 'away', score: away.score, winner: away.winner, team: { id: away.id ?? '2', abbreviation: away.abbr ?? 'AWAY' } },
      ],
    }],
  }
}
// Shapes observed on ESPN's public scoreboard (January 2026).
const FINAL = { name: 'STATUS_FINAL', state: 'post', completed: true, detail: 'Final', shortDetail: 'Final' }
const FINAL_OT = { ...FINAL, detail: 'Final/OT', shortDetail: 'Final/OT' }
const POSTPONED = { name: 'STATUS_POSTPONED', state: 'post', completed: false, detail: 'Postponed', shortDetail: 'Postponed' }

test('regulation and overtime finals grade from the winner flag', () => {
  assert.equal(resultOf(event(FINAL, { score: '65', winner: false }, { score: '86', winner: true })), 'away_win')
  assert.equal(resultOf(event(FINAL_OT, { score: '79', winner: true }, { score: '74', winner: false })), 'home_win')
  assert.equal(resultOf(event({ ...FINAL, name: 'STATUS_FINAL_OT' }, { score: '80' }, { score: '81' })), 'away_win')
})

test('a final with no winner flag grades only on unequal scores', () => {
  assert.equal(resultOf(event(FINAL, { score: '70' }, { score: '64' })), 'home_win')
  assert.equal(resultOf(event(FINAL, { score: '70' }, { score: '70' })), 'pending', 'equal scores are not a tie or a win')
  assert.equal(resultOf(event(FINAL, { score: '0' }, { score: '0' })), 'pending', '0–0 is never graded')
  assert.equal(resultOf(event(FINAL, { score: '70', winner: true }, { score: '70', winner: true })), 'pending')
})

test('missing or malformed scores stay pending', () => {
  assert.equal(resultOf(event(FINAL, {}, { score: '60', winner: true })), 'pending')
  assert.equal(resultOf(event(FINAL, { score: '' }, { score: '60' })), 'pending', 'an empty string is not zero')
  assert.equal(resultOf(event(FINAL, { score: '7O' }, { score: '60' })), 'pending')
})

test('a winner flag that contradicts the score stays pending', () => {
  assert.equal(resultOf(event(FINAL, { score: '60', winner: true }, { score: '72' })), 'pending')
  assert.equal(resultOf(event(FINAL, { score: '60' }, { score: '72', winner: false })), 'pending')
  assert.equal(resultOf(event(FINAL, { score: '80', winner: true }, { score: '72', winner: true })), 'pending')
})

test('postponed, cancelled, suspended, forfeited, delayed and unknown statuses are unresolved', () => {
  assert.equal(resultOf(event(POSTPONED, { score: '0', winner: null }, { score: '0', winner: null })), 'pending')
  for (const name of ['STATUS_CANCELED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT', 'STATUS_DELAYED', 'STATUS_ABANDONED', 'STATUS_SOMETHING_NEW']) {
    // Even if ESPN marked one completed with a winner, only a final code grades.
    assert.equal(resultOf(event({ ...FINAL, name }, { score: '2', winner: true }, { score: '0' })), 'pending', name)
  }
  assert.equal(resultOf(event({ state: 'post', completed: true }, { score: '70' }, { score: '64' })), 'pending', 'a missing status code is not final')
  assert.equal(resultOf(event({ ...FINAL, state: 'in' }, { score: '70' }, { score: '64' })), 'pending')
  assert.equal(resultOf(event({ ...FINAL, completed: false }, { score: '70' }, { score: '64' })), 'pending')
})

test('both teams must be identified and distinct', () => {
  assert.equal(resultOf(event(FINAL, { score: '70', abbr: '' }, { score: '64' })), 'pending')
  assert.equal(resultOf(event(FINAL, { score: '70', id: '9' }, { score: '64', id: '9' })), 'pending')
})

test('boards only show definitive finals as final', () => {
  assert.equal(displayStateOf(event(POSTPONED, { score: '0' }, { score: '0' })), 'pre', 'postponed never reads as a 0–0 final')
  assert.equal(displayStateOf(event({ ...FINAL, name: 'STATUS_CANCELED', completed: false }, { score: '0' }, { score: '0' })), 'pre')
  assert.equal(displayStateOf(event(FINAL, { score: '70' }, { score: '70' })), 'pre')
  assert.equal(displayStateOf(event(FINAL, { score: '70' }, { score: '64' })), 'post')
  assert.equal(displayStateOf(event({ name: 'STATUS_IN_PROGRESS', state: 'in', completed: false }, { score: '30' }, { score: '30' })), 'in')
})

test('events match stored games on stable team ids, falling back to abbreviations for legacy rows', () => {
  const live = event({ state: 'pre', completed: false }, { id: '10', abbr: 'MIA' }, { id: '20', abbr: 'DUKE' })
  assert.ok(scheduledEventSides({ home_team: 'MIA', away_team: 'DUKE', home_team_id: '10', away_team_id: '20' }, live))
  // Two schools share "MIA": the stored id says this is the other one.
  assert.equal(scheduledEventSides({ home_team: 'MIA', away_team: 'DUKE', home_team_id: '99', away_team_id: '20' }, live), null)
  assert.ok(scheduledEventSides({ home_team: 'MIA', away_team: 'DUKE' }, live), 'legacy rows without ids match on abbreviation')
  assert.equal(scheduledEventSides({ home_team: 'DUKE', away_team: 'MIA' }, live), null, 'a reversed non-neutral game is a different game')
  const neutral = event({ state: 'pre', completed: false }, { id: '10', abbr: 'MIA' }, { id: '20', abbr: 'DUKE' }, true)
  const flipped = scheduledEventSides({ home_team: 'DUKE', away_team: 'MIA', home_team_id: '20', away_team_id: '10' }, neutral)
  assert.equal(flipped?.flipped, true)
  assert.equal(flipped?.home.team.abbreviation, 'DUKE')
})
