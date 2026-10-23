// Requires an EMPTY, disposable PostgreSQL database. No production default.
import pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const url = process.env.STAGING_DATABASE_URL
if (!url || process.env.CONCURRENCY_TEST_ACK !== 'EMPTY_DISPOSABLE_DATABASE') throw new Error('Provide an empty disposable database and acknowledge it explicitly')
const clients = []
async function client() {
 const db = new pg.Client({connectionString: url}); await db.connect()
 await db.query("set statement_timeout='10s';set deadlock_timeout='100ms'")
 clients.push(db); return db
}
const setup = await client(), picker = await client(), mover = await client()
try {
 if ((await setup.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows[0].n) throw new Error('Database must be empty; refusing to reset existing data')
 for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) await setup.query(`do $$begin create role ${role};exception when duplicate_object then null;end$$`)
 for (const file of (await readdir('supabase/migrations')).filter(file => file.endsWith('.sql')).sort()) await setup.query(await readFile(`supabase/migrations/${file}`, 'utf8'))
 const pidOf = async db => (await db.query('select pg_backend_pid() pid')).rows[0].pid
 const pickerPid = await pidOf(picker), moverPid = await pidOf(mover)
 async function blocked(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
   if ((await setup.query('select cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked) return
   await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('Expected a real inter-session lock wait')
 }
 for (const schema of ['public', 'sandbox']) {
  for (const db of clients) await db.query(`set search_path=${schema},pg_catalog`)
  const oldSlate = randomUUID(), newSlate = randomUUID(), player = randomUUID(), game = randomUUID()
  await setup.query(`update pools set season_year=2099,competition_mode='regular-season',pick_frequency='every-game-day';
   insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values
   ('${oldSlate}',1,'2099-03-19',2099,true,'2099-03-19T18:00:00Z'),('${newSlate}',2,'2099-03-20',2099,false,'2099-03-20T18:00:00Z');
   insert into players(id,full_name,email,pin_hash) values('${player}','Fixture','fixture@example.test','fixture');
   insert into games(id,slate_id,espn_event_id,home_team,away_team,tip_time) values('${game}','${oldSlate}','picked','A','B','2099-03-19T18:00:00Z');`)
  // Pick commits after the schedule updater has started its statement. The
  // trigger must use a fresh snapshot AFTER waiting for the pick's slate lock.
  await picker.query('begin')
  await picker.query("select save_pick($1,$2,'A',$3)", [player, oldSlate, randomUUID()])
  const moveAfterPick = mover.query("update games set slate_id=$1,result='away_win' where id=$2 returning id", [newSlate, game])
  await blocked(moverPid)
  await picker.query('commit')
  assert.equal((await moveAfterPick).rows.length, 0)
  const preserved = (await setup.query('select slate_id,result from games where id=$1', [game])).rows[0]
  assert.deepEqual(preserved, {slate_id: oldSlate, result: 'pending'})
  assert.equal((await setup.query('select game_id from picks where player_id=$1', [player])).rows[0].game_id, game)
  assert.equal((await setup.query("select status from incidents where key=$1", [`schedule-change:${game}`])).rows[0].status, 'open')
  assert.equal((await mover.query('delete from games where id=$1 returning id', [game])).rows.length, 0)
  console.log(`PASS real PostgreSQL ${schema}: picked game move waits for commit, fresh snapshot preserves identity/outcome/linkage and persists incident; delete also held`)

  // Inverse ordering: a schedule move wins before an otherwise valid pick.
  // The pick waits, then reads the changed schedule and cannot attach to old day.
  const nextOld = randomUUID(), nextNew = randomUUID(), nextPlayer = randomUUID(), nextGame = randomUUID()
  await setup.query(`update slates set is_active=false;
   insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values
   ('${nextOld}',3,'2099-03-21',2099,true,'2099-03-21T18:00:00Z'),('${nextNew}',4,'2099-03-22',2099,false,'2099-03-22T18:00:00Z');
   insert into players(id,full_name,email,pin_hash) values('${nextPlayer}','Other fixture','other@example.test','fixture');
   insert into games(id,slate_id,espn_event_id,home_team,away_team,tip_time) values('${nextGame}','${nextOld}','unpicked','C','D','2099-03-21T18:00:00Z');`)
  await mover.query('begin')
  assert.equal((await mover.query('update games set slate_id=$1 where id=$2 returning id', [nextNew, nextGame])).rows.length, 1)
  const pickAfterMove = picker.query("select save_pick($1,$2,'C',$3)", [nextPlayer, nextOld, randomUUID()]).then(() => null, error => error)
  await blocked(pickerPid)
  await mover.query('commit')
  assert.match((await pickAfterMove)?.message ?? '', /unavailable|not playing/)
  assert.equal((await setup.query('select count(*)::int n from picks where player_id=$1', [nextPlayer])).rows[0].n, 0)
  assert.equal((await setup.query('select slate_id from games where id=$1', [nextGame])).rows[0].slate_id, nextNew)
  await mover.query('begin isolation level repeatable read')
  await assert.rejects(mover.query("update games set home_team='OTHER' where id=$1", [nextGame]), /require READ COMMITTED/)
  await mover.query('rollback')
  console.log(`PASS real PostgreSQL ${schema}: inverse move/pick race rejects stale-period pick; non-READ-COMMITTED identity changes fail closed`)
 }
} finally {
 for (const db of clients) await db.query('rollback').catch(() => {})
 await Promise.all(clients.map(db => db.end()))
}
