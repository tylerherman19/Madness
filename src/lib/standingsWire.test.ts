import test from 'node:test'
import assert from 'node:assert/strict'
import { unpackAlive, unpackOut, type PackedAlive, type PackedOut } from './standingsWire.ts'
import { survivedPeriodsByOutcome, survivedPeriodsByPlayer } from './survival.ts'

test('a packed row with only a name expands to the no-pick defaults', () => {
  const [row, bare] = unpackAlive([{ n: 'Ada' }, 'Ada'])
  assert.deepEqual(bare, row)
  assert.deepEqual(row, { id: 'Ada', name: 'Ada', me: false, teams: [], status: 'none', seedTotal: 0 })
})

test('packed alive rows keep status, teams, seed total and the viewer flag', () => {
  const packed: PackedAlive[] = [{ n: 'Me', me: 1, t: ['Duke'], s: 's' }, { n: 'Bo', t: ['Kansas'], s: 'p', v: 9 }, { n: 'Cy', s: 'l' }]
  const rows = unpackAlive(packed)
  assert.deepEqual(rows.map((r) => [r.me, r.status, r.teams, r.seedTotal]), [[true, 'submitted', ['Duke'], 0], [false, 'picked', ['Kansas'], 9], [false, 'locked', [], 0]])
})

test('packed eliminated rows rebuild the day label and the losing-pick sentence from the team names', () => {
  const packed: PackedOut[] = [{ n: 'Di', o: 3, t: ['DUKE', 'UNC'] }, { n: 'Ed', o: 3, r: 'Missed the deadline' }, { n: 'Flo' }]
  const rows = unpackOut(packed, { 3: 'Out Thursday' }, (team) => ({ DUKE: 'Duke', UNC: 'UNC' })[team] ?? team)
  assert.equal(rows[0].out, 'Out Thursday')
  assert.equal(rows[0].losing, 'Picked Duke, UNC, lost')
  assert.equal(rows[1].losing, 'Missed the deadline')
  assert.deepEqual([rows[2].out, rows[2].losing], ['Out', null])
})

test('counting survived periods from outcomes matches counting them from games', () => {
  const picks = [
    { player_id: 'p', slate_id: 's1', team: 'A', loss_excused: false },
    { player_id: 'p', slate_id: 's2', team: 'C', loss_excused: false },
    { player_id: 'p', slate_id: 's3', team: 'E', loss_excused: true },
    { player_id: 'q', slate_id: 's1', team: 'B', loss_excused: false },
    { player_id: 'q', slate_id: 's2', team: 'D', loss_excused: false },
  ]
  const games = [
    { slate_id: 's1', home_team: 'A', away_team: 'B', result: 'home_win' },
    { slate_id: 's2', home_team: 'C', away_team: 'D', result: 'away_win' },
    { slate_id: 's3', home_team: 'E', away_team: 'F', result: 'away_win' },
  ]
  const periods = { s1: { key: 'r1', quota: 2 }, s2: { key: 'r1', quota: 2 }, s3: { key: 's3', quota: 1 } }
  const won = (pick: (typeof picks)[number]) => {
    const game = games.find((g) => g.slate_id === pick.slate_id && (g.home_team === pick.team || g.away_team === pick.team))!
    return pick.loss_excused || game.result === (game.home_team === pick.team ? 'home_win' : 'away_win')
  }
  assert.deepEqual(
    survivedPeriodsByOutcome(picks.map((p) => ({ player_id: p.player_id, slate_id: p.slate_id, won: won(p) })), periods),
    survivedPeriodsByPlayer(picks, games, periods)
  )
})
