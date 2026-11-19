import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

// The 2027 Elite Eight pair is auto-assigned once, after Saturday's first tip.
// If that run is late (outage, waiting on AP rankings, legacy daily cron),
// Saturday's games may already be final when the pair is written. One half of
// the pair having lost must not block writing the other half: the entry gets
// its two picks and grading eliminates it, instead of staying alive with no
// picks and blocking Sunday.

const db = new PGlite()
await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
const migrations = (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
for (const f of migrations) await db.exec(await readFile('supabase/migrations/' + f, 'utf8'))
// Re-applying 042 must leave the patched function as it is.
await db.exec(await readFile('supabase/migrations/042_elite_pair_late_assignment.sql', 'utf8'))
const scalar = async (sql) => Object.values((await db.query(sql)).rows[0] ?? {})[0]
const id = n => '52000000-0000-4000-8000-' + String(n).padStart(12, '0')
const insertGames = async (d, count, round) => {
  for (let i = 1; i <= count; i++) await db.exec(`insert into sandbox.games
   (slate_id,espn_event_id,home_team,away_team,home_team_id,away_team_id,home_seed,away_seed,round_label,tip_time)
   values('${id(d)}','m${d}-${i}','H${d}-${i}','A${d}-${i}','h${d}-${i}','a${d}-${i}',${((i - 1) % 8) + 1},${16 - ((i - 1) % 8)},'${round}','2027-03-${d} 17:00Z')`)
}

await db.exec(`set session_replication_role=replica; delete from sandbox.picks;delete from sandbox.games;delete from sandbox.slates;delete from sandbox.players;
 update sandbox.pools set season_year=2027,competition_mode='regular-season',starts_on=null,status='live' where is_active;
 set session_replication_role=origin;
 update sandbox.clock set simulated_now='2027-03-17 12:00Z';
 insert into sandbox.slates(id,slate_date,slate_number,season_year,locks_at) values
 ${[18, 26, 27, 28].map(d => `('${id(d)}','2027-03-${d}',${d},2027,'2027-03-${d} 17:00Z')`).join(',')};`)
const pool = await scalar('select id from sandbox.pools where is_active')
await insertGames(18, 16, 'Round of 64')
await scalar(`select sandbox.start_fresh_tournament('${pool}','${id(18)}','test','fixture')`)
for (const n of [2, 3, 4, 5]) await db.exec(`insert into sandbox.players(id,full_name,email,pin_hash) values('${id(n)}','Player ${n}','p${n}@example.test','x')`)
// Player 4's Sweet 16 pick lost, but grading has not run yet: it is still alive.
await insertGames(26, 2, 'Sweet 16')
await db.exec(`set session_replication_role=replica;
 insert into sandbox.picks (player_id,slate_id,team,seed) values('${id(4)}','${id(26)}','A26-1',5);
 update sandbox.games set result='home_win',status_state='post' where slate_id='${id(26)}';
 set session_replication_role=origin;`)

await insertGames(27, 2, 'Elite 8')
await insertGames(28, 2, 'Elite 8')
await db.exec(`select sandbox.activate_slate('${id(27)}'); update sandbox.clock set simulated_now='2027-03-27 16:59Z';`)
const pair = (n, picks) => scalar(`select sandbox.save_march_2027_elite_pair('${id(n)}',gen_random_uuid(),$p$${JSON.stringify(picks.map(([d, team]) => ({ slate_id: id(d), team })))}$p$)`)
await pair(5, [[27, 'H27-1'], [28, 'H28-1']])

// Lock passes. The assignment run is late: Saturday is already final.
// H27-1 (1 seed) lost; H27-2 won.
await db.exec(`update sandbox.clock set simulated_now='2027-03-28 06:00Z';
 update sandbox.games set result=case when espn_event_id='m27-1' then 'away_win' else 'home_win' end,status_state='post' where slate_id='${id(27)}';`)

const token = await scalar(`select sandbox.begin_assignment('${id(27)}')`)
const assign = (n, teams, expected = 0) => db.exec(`select sandbox.apply_assignment('${id(27)}','${token}','${id(n)}',
 $t$${JSON.stringify(teams.map(([d, team, seed]) => ({ team, seed, slate_id: id(d) })))}$t$::jsonb,null,
 array['${id(27)}','${id(28)}']::uuid[],${expected})`)
const picksOf = n => db.query(`select team, auto_assigned from sandbox.picks where player_id='${id(n)}' and slate_id in('${id(27)}','${id(28)}') order by team`).then(r => r.rows)

// The losing Saturday team is written first, then the Sunday team.
await assign(2, [[27, 'H27-1', 1], [28, 'H28-1', 1]])
assert.deepEqual(await picksOf(2), [{ team: 'H27-1', auto_assigned: true }, { team: 'H28-1', auto_assigned: true }],
  'A late pair is written even when its Saturday half already lost')
// Both halves already lost.
await db.exec(`update sandbox.games set result='away_win' where slate_id='${id(27)}'`)
await assign(3, [[27, 'H27-1', 1], [27, 'H27-2', 2]])
assert.equal((await picksOf(3)).length, 2, 'A late pair is written when both halves already lost')

// An earlier-round loss still blocks a new pick until grading catches up.
await assert.rejects(assign(4, [[27, 'H27-1', 1], [28, 'H28-1', 1]]), /previous pick lost/)
assert.equal((await picksOf(4)).length, 0)
// A pick outside the pair period is still refused after a pair half lost.
await assert.rejects(db.exec(`insert into sandbox.picks (player_id,slate_id,team,auto_assigned) values('${id(2)}','${id(26)}','H26-2',true)`), /previous pick lost/)

// An organizer write outside the pair is still refused after a pair half lost.
await assert.rejects(db.exec(`insert into sandbox.picks (player_id,slate_id,team,submitted_by_admin) values('${id(2)}','${id(26)}','H26-2',true)`), /previous pick lost/)
// A player's own change to the other half (saved as a player write) is still refused.
await assert.rejects(db.exec(`update sandbox.picks set team='A28-1',auto_assigned=false where player_id='${id(2)}' and team='H28-1'`), /previous pick lost/)

await db.exec(`select sandbox.finish_assignment('${id(27)}','${token}',true)`)
const graded = await scalar(`select sandbox.regrade_slate('${id(27)}')`)
assert.deepEqual([...graded.eliminated].sort(), ['Player 2', 'Player 3', 'Player 5'], 'Grading eliminates the late pairs and the manual pair that lost')
console.log('PASS late Elite Eight assignment: pair written after a Saturday loss, both-lost pair, earlier loss still blocks, graded out')
