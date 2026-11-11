import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistoryRows, pickOutcome, type HistoryGame } from './contestHistoryRows.ts'

const games: HistoryGame[] = [
  { slate_id: 's1', home_team: 'A', away_team: 'B', result: 'home_win', round_label: null },
  { slate_id: 's1', home_team: 'C', away_team: 'D', result: 'tie', round_label: null },
  { slate_id: 's2', home_team: 'E', away_team: 'F', result: 'pending', round_label: null },
]
const pick = (player_id: string, slate_id: string, team: string, extra = {}) =>
  ({ player_id, slate_id, team, seed: 3, loss_excused: false, auto_assigned: false, ...extra })

test('pick outcomes follow the stored result; an excused loss is neutral', () => {
  assert.equal(pickOutcome(pick('p', 's1', 'A'), games), 'won')
  assert.equal(pickOutcome(pick('p', 's1', 'B'), games), 'lost')
  assert.equal(pickOutcome(pick('p', 's1', 'C'), games), 'lost')
  assert.equal(pickOutcome(pick('p', 's1', 'B', { loss_excused: true }), games), 'pending')
  assert.equal(pickOutcome(pick('p', 's2', 'E'), games), 'pending')
})

test('final standings: alive first, then wins, then later elimination, then name; unknown entries ignored', () => {
  const rows = buildHistoryRows({
    entries: [
      { id: 'out-early', full_name: 'Zed', status: 'eliminated', elimination_slate: 1, elimination_reason: 'lost' },
      { id: 'alive', full_name: 'Amy', status: 'alive', elimination_slate: null, elimination_reason: null },
      { id: 'out-late', full_name: 'Bea', status: 'eliminated', elimination_slate: 2, elimination_reason: 'lost' },
    ],
    picks: [pick('alive', 's1', 'A'), pick('out-early', 's1', 'B'), pick('out-late', 's1', 'A'), pick('ghost', 's1', 'A')],
    games,
  })
  assert.deepEqual(rows.map((row) => row.id), ['alive', 'out-late', 'out-early'])
  assert.equal(rows[0].wins, 1)
  assert.equal(rows[0].seedTotal, 3)
  assert.deepEqual(rows[2].bySlate.s1, [{ team: 'B', outcome: 'lost', auto: false }])
})
