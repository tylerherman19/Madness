import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
const migrations = (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
const apply = async f => db.exec(await readFile('supabase/migrations/' + f, 'utf8'))
for (const f of migrations) await apply(f)
for (const f of migrations.filter(f => /^03[789]_/.test(f))) await apply(f)
const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0]
const id = n => '51000000-0000-4000-8000-' + String(n).padStart(12, '0')
const insertGames = async (d, count, round) => {
 for (let i=1;i<=count;i++) await db.exec(`insert into sandbox.games
  (slate_id,espn_event_id,home_team,away_team,home_team_id,away_team_id,home_seed,away_seed,round_label,tip_time)
  values('${id(d)}','m${d}-${i}','H${d}-${i}','A${d}-${i}','h${d}-${i}','a${d}-${i}',${i===3?12:1},16,'${round}','2027-03-${d} 17:00Z')`)
}
await db.exec(`set session_replication_role=replica; delete from sandbox.picks;delete from sandbox.games;delete from sandbox.slates;delete from sandbox.players;
 update sandbox.pools set season_year=2027,competition_mode='regular-season',starts_on=null,status='live' where is_active;
 set session_replication_role=origin;
 update sandbox.clock set simulated_now='2027-03-17 12:00Z';
 insert into sandbox.players(id,full_name,email,pin_hash,paid) values('${id(1)}','Archived player','old@example.test','x',true);
 insert into sandbox.slates(id,slate_date,slate_number,season_year,locks_at) values
 ${[16,17,18,19,27,28].map(d=>`('${id(d)}','2027-03-${d}',${d},2027,'2027-03-${d} 17:00Z')`).join(',')};`)
const pool = await scalar('select id from sandbox.pools where is_active')
const open = d => scalar(`select sandbox.start_fresh_tournament('${pool}','${id(d)}','test','fixture')`)
for (const d of [16,17,19]) await assert.rejects(open(d), /March 18 is the only/)
await assert.rejects(open(18), /all 16 verified/)
await assert.rejects(db.exec(`update sandbox.pools set competition_mode='march-madness',starts_on='2027-03-19' where is_active`), /March 18/)
assert.equal(await scalar('select count(*)::int from sandbox.players where paid'),1)
await insertGames(18,16,'Round of 64')
const archive = await open(18)
assert.equal(await scalar(`select snapshot->'players'->0->>'paid' from sandbox.contest_archives where id='${archive}'`),'true')
assert.equal(await scalar('select pick_frequency from sandbox.pools where is_active'),'every-game-day')
for (const n of [2,3,4]) await db.exec(`insert into sandbox.players(id,full_name,email,pin_hash) values('${id(n)}','Player ${n}','p${n}@example.test','x')`)
assert.equal(await scalar("select count(*)::int from sandbox.notification_outbox where kind='welcome' and status='held'"),3)
await db.exec(`insert into sandbox.picks (player_id,slate_id,team,seed) values
 ('${id(2)}','${id(18)}','H18-3',12),('${id(3)}','${id(18)}','H18-1',1);`)
await assert.rejects(db.exec(`insert into sandbox.picks (player_id,slate_id,team) values('${id(2)}','${id(18)}','A18-2')`), /quota/)
await assert.rejects(db.exec(`select sandbox.activate_slate('${id(17)}')`), /outside/)
await db.exec(`update sandbox.games set result='home_win' where slate_id='${id(18)}'; update sandbox.players set status='eliminated',elimination_slate=18 where id='${id(4)}';`)
await insertGames(27,2,'Elite Eight')
await insertGames(28,2,'Elite 8')
await db.exec(`select sandbox.activate_slate('${id(27)}'); update sandbox.clock set simulated_now='2027-03-27 16:59Z';`)
const choose = (n,d,team,pick=null,expected=null) => scalar(`select sandbox.save_pick('${id(n)}','${id(d)}','${team}',gen_random_uuid(),${pick ? `'${pick}','${expected}'` : 'null,null'})`)
const sun = await choose(2,28,'A28-1')
assert.equal(new Date(sun.deadline).toISOString(), '2027-03-27T17:00:00.000Z')
const moved = await choose(2,27,'A27-1',sun.pick.id,sun.acceptedAt)
assert.equal(moved.pick.slate_id,id(27))
await choose(2,27,'A27-2')
await assert.rejects(choose(2,28,'A28-2'), /quota/)
await choose(3,28,'A28-1')
await choose(3,28,'A28-2')
await db.exec("update sandbox.clock set simulated_now='2027-03-27 17:00Z'")
await assert.rejects(choose(3,28,'H28-1'), /locked/)
await assert.rejects(db.exec(`insert into sandbox.players(full_name,email,pin_hash) values('Late','late@example.test','x')`), /registration has closed/)
const token = await scalar(`select sandbox.begin_assignment('${id(27)}')`)
await db.exec(`select sandbox.finish_assignment('${id(27)}','${token}',true)`)
await db.exec(`update sandbox.games set result='home_win' where slate_id in('${id(27)}','${id(28)}')`)
assert.equal(await scalar(`select sandbox.finish_march_2027('${id(27)}')`),null)
await db.exec(`update sandbox.players set status='eliminated',elimination_slate=27 where id='${id(2)}';select sandbox.activate_slate('${id(28)}');
 update sandbox.slates set auto_assign_completed_at=now() where id='${id(28)}';
 update sandbox.players set status='eliminated',elimination_slate=28 where id='${id(3)}';`)
const final = await scalar(`select sandbox.finish_march_2027('${id(28)}')`)
assert.deepEqual(final.winners,[{name:'Player 3',seed_total:1}],'Only the last day’s cohort is eligible, and only wins score')
assert.equal(final.reason,'all-eliminated')
assert.equal(await scalar('select status from sandbox.pools where is_active'),'completed')
assert.equal(await scalar("select has_function_privilege('anon','sandbox.finish_march_2027(uuid)','EXECUTE')"),false)
assert.equal(await scalar("select has_function_privilege('service_role','sandbox.finish_march_2027(uuid)','EXECUTE')"),true)
console.log('PASS March 2027: exact migrations/reapply, three rejected dates, incomplete slate, archived payment, daily quotas, both Elite Eight selections and moves, opening and round locks, welcome intent, winner and ACL')
await db.close()
