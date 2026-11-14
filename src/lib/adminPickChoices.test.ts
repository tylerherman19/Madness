import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickChoices } from './adminPickChoices.ts'

const games = [{ home_team: 'MINN', away_team: 'WIS' }, { home_team: 'DUKE', away_team: 'UNC' }]
test('lists only the teams playing, labelled by opponent', () => {
  const list = pickChoices(games, [])
  assert.deepEqual(list.map((c) => c.team), ['DUKE', 'MINN', 'UNC', 'WIS'])
  assert.equal(list.find((c) => c.team === 'WIS')?.label, 'WIS (vs MINN)')
})
test('hides used teams but keeps the current pick', () => {
  assert.deepEqual(pickChoices(games, ['DUKE', 'WIS'], 'WIS').map((c) => c.team), ['MINN', 'UNC', 'WIS'])
})
test('no games, no choices', () => assert.deepEqual(pickChoices([], []), []))
