// Independent contests (migration 030) on an isolated in-memory PostgreSQL.
// Never touches a hosted database.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { restoreCheck } from './restore-check.mjs'

const db = new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
for (const file of files.filter((f) => f < '030_')) await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
const contests = await readFile('supabase/migrations/030_independent_contests.sql', 'utf8')

const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0] ?? { v: null })[0]
const fails = (sql, match, params = []) => assert.rejects(db.query(sql, params), match)

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const S1 = id(101), S2 = id(102), S10 = id(110)
const ALICE = id(1), BOB = id(2), CAROL = id(3)

// ---------------------------------------------------------------- legacy data (001-029)
for (const schema of ['public', 'sandbox']) {
  await db.exec(`set search_path=${schema},pg_catalog;`)
  if (schema === 'sandbox') await db.exec('update sandbox.clock set simulated_now=null;')
  await db.exec(`update pools set season_year=2099, name='MADNESS Regular Season';
   insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values
    ('${S1}',1,'2099-01-10',2099,false,now()+interval '1 day'),
    ('${S2}',2,'2099-01-11',2099,true,now()+interval '2 days'),
    ('${S10}',10,'2099-03-19',2099,false,now()+interval '12 hours');
   insert into games(slate_id,espn_event_id,home_team,away_team,tip_time) values
    ('${S1}','s1a','A','B',now()+interval '1 day'),('${S1}','s1c','C','D',now()+interval '1 day'),('${S1}','s1e','E','F',now()+interval '1 day'),
    ('${S2}','s2g','G','H',now()+interval '2 days');
   insert into games(slate_id,espn_event_id,home_team,away_team,tip_time,round_label) values
    ('${S10}','m1','A','Z',now()+interval '12 hours','1st Round'),('${S10}','m2','Q','R',now()+interval '13 hours','1st Round');
   insert into players(id,full_name,email,pin_hash) values
    ('${ALICE}','Alice','alice@example.test','h'),('${BOB}','Bob','bob@example.test','h'),('${CAROL}','Carol','carol@example.test','h');
   insert into picks(player_id,slate_id,team,submitted_by_admin) values
    ('${ALICE}','${S1}','A',true),('${BOB}','${S1}','C',true),('${CAROL}','${S1}','E',true),
    ('${ALICE}','${S2}','G',true),('${CAROL}','${S2}','H',true);
   update games set result='home_win',status_state='post' where espn_event_id in ('s1a','s1e','s2g');
   update games set result='away_win',status_state='post' where espn_event_id='s1c';
   update slates set locks_at=now()-interval '1 day' where id in ('${S1}','${S2}');`)
  // Bob is eliminated by real grading; Carol's S2 loss is deliberately left ungraded.
  assert.equal(await scalar(`select grade_pick_loss((select id from picks where player_id='${BOB}'),1,'Slate 1: picked C — lost')`), true)
}

// ---------------------------------------------------------------- migration on legacy rows, twice
const before = {}
for (const schema of ['public', 'sandbox'])
  before[schema] = await rows(`select (select count(*)::int from ${schema}.players) players, (select count(*)::int from ${schema}.picks) picks,
    (select count(*)::int from ${schema}.audit_log) audit, (select count(*)::int from ${schema}.pick_revisions) revisions`)
await db.exec(contests)
await db.exec(contests)
for (const schema of ['public', 'sandbox']) {
  await db.exec(`set search_path=${schema},pg_catalog;`)
  const after = await rows(`select (select count(*)::int from players) players, (select count(*)::int from picks) picks,
    (select count(*)::int from audit_log) audit, (select count(*)::int from pick_revisions) revisions`)
  assert.deepEqual(after, before[schema], 'Applying 030 twice deletes nothing and writes no pick/audit rows')
  const pool = await scalar('select id from pools where is_active')
  assert.equal(await scalar('select count(*)::int from players where pool_id=$1', [pool]), 3)
  assert.equal(await scalar('select count(*)::int from picks where pool_id=$1', [pool]), 5)
  assert.equal(await scalar(`select status from players where id='${BOB}'`), 'eliminated')
  assert.equal(await scalar(`select count(*)::int from pg_constraint where conrelid='${schema}.players'::regclass and contype='u'`), 0, 'global email constraint removed')
  assert.equal(await scalar(`select to_regclass('${schema}.players_normalized_email_unique')`), null)
  assert.ok(await scalar(`select to_regclass('${schema}.players_contest_email_unique')`))
  // picks.pool_id cannot disagree with the entry and is derived, not trusted.
  const other = await scalar(`insert into pools(name,season_year,is_active,status) values('Spare',2099,false,'draft') returning id`)
  await db.query(`update picks set pool_id=$1 where player_id='${ALICE}' and slate_id='${S1}'`, [other])
  assert.equal(await scalar(`select pool_id from picks where player_id='${ALICE}' and slate_id='${S1}'`), pool)
  await fails(`update players set pool_id=$1 where id='${ALICE}'`, /cannot move between contests/, [other])
  await fails(`insert into players(full_name,email,pin_hash,pool_id) values('X','x@example.test','h',$1)`, /only join the active contest/, [other])
  await db.query('delete from pools where id=$1', [other])
  console.log(`PASS ${schema}: 030 on legacy data is additive and idempotent; pool_id backfilled; per-contest email index; pick contest derived from entry`)
}

// ---------------------------------------------------------------- start March Madness without deleting
for (const schema of ['public', 'sandbox']) {
  await db.exec(`set search_path=${schema},pg_catalog;`)
  const oldPool = await scalar('select id from pools where is_active')
  assert.equal(await scalar('select count(*)::int from rule_versions where configuration->>$1=$2', ['id', oldPool]), 1, 'old contest rules were frozen by its picks')
  await fails(`select start_fresh_tournament($1,'${S10}','','admin')`, /reason/, [oldPool])
  await fails(`select start_fresh_tournament($1,'${S1}','March','admin')`, /future deadline/, [oldPool])
  const archive = await scalar(`select start_fresh_tournament($1,'${S10}','March Madness opens','admin')`, [oldPool])
  await fails(`select start_fresh_tournament($1,'${S10}','double click','admin')`, /active contest changed/, [oldPool])
  const newPool = await scalar('select id from pools where is_active')
  assert.notEqual(newPool, oldPool)
  assert.deepEqual(await rows('select is_active, status, ended_on::text from pools where id=$1', [oldPool]), [{ is_active: false, status: 'archived', ended_on: '2099-03-18' }])
  assert.equal(await scalar('select competition_mode from pools where id=$1', [newPool]), 'march-madness')
  assert.equal(await scalar('select count(*)::int from players'), 3, 'no entry deleted')
  assert.equal(await scalar('select count(*)::int from picks'), 5, 'no pick deleted')
  assert.equal(await scalar('select count(*)::int from players where pool_id=$1', [newPool]), 0)
  assert.equal(await scalar(`select jsonb_array_length(snapshot->'players') from contest_archives where id=$1`, [archive]), 3)
  assert.equal(await scalar(`select jsonb_array_length(snapshot->'picks') from contest_archives where id=$1`, [archive]), 5)
  assert.equal(await scalar(`select snapshot->>'kind' from contest_archives where id=$1`, [archive]), 'contest-rollover')
  assert.equal(await scalar('select id from slates where is_active'), S10)
  console.log(`PASS ${schema}: March Madness starts with zero entries; old contest archived with 3 entries and 5 picks intact; snapshot verified; repeat refused`)

  // ------------------------------------------------------------- registration per contest
  const NEW_ALICE = await scalar(`insert into players(full_name,email,pin_hash) values('Alice','alice@example.test','h') returning id`)
  const DAVE = await scalar(`insert into players(full_name,email,pin_hash) values('Dave','dave@example.test','h') returning id`)
  assert.equal(await scalar('select pool_id from players where id=$1', [NEW_ALICE]), newPool)
  await fails(`insert into players(full_name,email,pin_hash) values('Alice again',' ALICE@Example.test ','h')`, /players_contest_email_unique/)
  assert.equal(await scalar(`select count(*)::int from players where lower(email)='alice@example.test'`), 2)
  console.log(`PASS ${schema}: same email registers in the new contest; duplicate within one contest rejected`)

  // ------------------------------------------------------------- independent statuses, reuse and quotas
  await fails(`insert into picks(player_id,slate_id,team) values('${ALICE}','${S10}','Q')`, /no longer active/)
  await db.query(`insert into picks(player_id,slate_id,team) values($1,'${S10}','A')`, [NEW_ALICE]) // A was Alice's team in the old contest
  await fails(`insert into picks(player_id,slate_id,team) values($1,'${S10}','A')`, /Team already used/, [NEW_ALICE])
  await db.query(`insert into picks(player_id,slate_id,team) values($1,'${S10}','Q')`, [NEW_ALICE])
  await fails(`insert into picks(player_id,slate_id,team) values($1,'${S10}','R')`, /quota/, [NEW_ALICE])
  assert.equal(await scalar(`select pool_id from picks where player_id=$1 limit 1`, [NEW_ALICE]), newPool)
  assert.equal(await scalar(`select count(*)::int from pick_revisions r join rule_versions v on v.id=r.rule_version where r.player_id=$1 and v.configuration->>'id'=$2`, [NEW_ALICE, newPool]), 2, 'receipts cite the new contest rules')

  // Counts are per contest.
  let counts = await scalar('select contest_counts()')
  assert.equal(counts.players, 2); assert.equal(counts.alive, 2); assert.equal(counts.complete, 1); assert.equal(counts.missing, 1)
  assert.equal(counts.pool_id, newPool)
  const reconcile = await scalar('select reconcile_contest()')
  assert.equal(reconcile.ungraded_losing_picks, 0, "archived Carol's ungraded loss is not the active contest's work")

  // Reminders reach only the active contest's entries.
  const everyone = (await rows('select id from players')).map((r) => r.id)
  assert.equal(await scalar(`select queue_pick_reminders('${S10}',$1::uuid[],array['${S10}'::uuid],2,now()+interval '12 hours','Soon','24h')`, [everyone]), 1, 'only Dave is reminded')
  assert.equal(await scalar(`select count(*)::int from notification_outbox where kind='reminder' and player_id in ('${ALICE}','${CAROL}')`), 0)

  // Grading, restoration and assignment never reach the archived contest.
  const carolLoss = await scalar(`select id from picks where player_id='${CAROL}' and slate_id='${S2}'`)
  assert.equal(await scalar(`select grade_pick_loss($1,2,'stale')`, [carolLoss]), false)
  assert.equal(await scalar(`select status from players where id='${CAROL}'`), 'alive')
  await fails(`select restore_player('${BOB}','Dispute','admin')`, /archived contest/)
  const token = await scalar(`select begin_assignment('${S10}')`)
  assert.ok(token)
  await fails(`select apply_assignment('${S10}',$1,'${CAROL}','[]'::jsonb,'Missed',null,0)`, /not in the active contest/, [token])
  await db.query(`select apply_assignment('${S10}',$1,$2,'[]'::jsonb,'Missed the round quota',array['${S10}'::uuid],0)`, [token, DAVE])
  assert.equal(await scalar('select status from players where id=$1', [DAVE]), 'eliminated')
  assert.equal(await scalar(`select status from players where id='${CAROL}'`), 'alive')
  // An active-contest loss eliminates only the new entry, never the old one.
  await db.exec(`update slates set locks_at=now()-interval '1 minute' where id='${S10}'; update games set result='away_win',status_state='post' where espn_event_id='m1';`)
  const lost = await scalar(`select id from picks where player_id=$1 and team='A'`, [NEW_ALICE])
  assert.equal(await scalar(`select grade_pick_loss($1,10,'Slate 10: picked A — lost')`, [lost]), true)
  assert.equal(await scalar('select status from players where id=$1', [NEW_ALICE]), 'eliminated')
  assert.equal(await scalar(`select status from players where id='${ALICE}'`), 'alive')
  await db.query(`select restore_player($1,'Organizer ruling','admin')`, [NEW_ALICE])
  assert.equal(await scalar('select status from players where id=$1', [NEW_ALICE]), 'alive')
  assert.deepEqual((await rows(`select status from players where pool_id=$1 order by full_name`, [oldPool])).map((r) => r.status), ['alive', 'eliminated', 'alive'])
  // Archived picks never block the active contest's grading bookkeeping.
  assert.equal(await scalar(`select mark_results_graded(jsonb_build_array(jsonb_build_object('id',(select id from games where espn_event_id='s2g'),'result','home_win')))`), 1)
  counts = await scalar('select contest_counts()')
  assert.equal(counts.players, 2); assert.equal(counts.eliminated, 1)
  console.log(`PASS ${schema}: grading, restoration, assignment and reminders stay inside each contest; team reuse and quotas are per contest; counts separate`)

  // ------------------------------------------------------------- archived standings stay viewable
  const list = await scalar('select contest_history_list()')
  assert.deepEqual(list.map((c) => [c.id, c.entries, c.source]), [[oldPool, 3, 'live']])
  const history = await scalar('select contest_history($1)', [oldPool])
  assert.equal(history.source, 'live')
  assert.equal(history.entries.length, 3)
  assert.equal(history.picks.length, 5)
  assert.deepEqual(history.slates.map((s) => s.id).sort(), [S1, S2].sort())
  assert.ok(!JSON.stringify(history).includes('example.test') && !JSON.stringify(history).includes('pin_hash'), 'no emails or credentials')
  assert.equal(await scalar('select contest_history($1)', [newPool]), null, 'active contest is never served by history')
  // A contest archived by the old (023) flow survives only as JSON.
  const legacyPool = await scalar(`insert into pools(name,season_year,is_active,status,ended_on) values('MADNESS 2098',2098,false,'archived','2098-03-01') returning id`)
  await db.query(`insert into contest_archives(pool_id,snapshot,reason) values($1,$2::jsonb,'March')`, [legacyPool, JSON.stringify({
    pool: { id: legacyPool }, players: [{ id: id(900), full_name: 'Old Timer', email: 'old@example.test', pin_hash: 'secret', status: 'eliminated', elimination_slate: 3, elimination_reason: 'lost' }],
    picks: [{ id: id(901), player_id: id(900), slate_id: S1, team: 'B', seed: null }], slates: [], games: [], notifications: [] })])
  const legacy = await scalar('select contest_history($1)', [legacyPool])
  assert.equal(legacy.source, 'archive')
  assert.deepEqual(legacy.entries.map((e) => e.full_name), ['Old Timer'])
  assert.equal(legacy.picks.length, 1)
  assert.ok(!JSON.stringify(legacy).includes('secret') && !JSON.stringify(legacy).includes('old@example.test'))
  assert.equal((await scalar('select contest_history_list()')).length, 2)
  console.log(`PASS ${schema}: archived standings and picks retrievable from live rows; legacy JSON-only archive readable without emails or hashes`)

  // ------------------------------------------------------------- guarded deletion of an archived contest
  const preview = await scalar('select delete_archived_contest_preview($1)', [oldPool])
  assert.equal(preview.players, 3); assert.equal(preview.picks, 5); assert.equal(preview.deletable, true)
  assert.equal(preview.players, await scalar('select count(*)::int from players where pool_id=$1', [oldPool]))
  assert.equal((await scalar('select delete_archived_contest_preview($1)', [newPool])).deletable, false)
  await fails(`select delete_archived_contest($1,'MADNESS March Madness','reason','admin')`, /active contest cannot be deleted/, [newPool])
  const completed = await scalar(`insert into pools(name,season_year,is_active,status) values('Done',2097,false,'completed') returning id`)
  await fails(`select delete_archived_contest($1,'Done','reason','admin')`, /Only archived/, [completed])
  await fails(`select delete_archived_contest($1,'MADNESS regular season','reason','admin')`, /exact contest name/, [oldPool])
  await fails(`select delete_archived_contest($1,'MADNESS Regular Season','  ','admin')`, /reason is required/, [oldPool])
  const archivesBefore = await scalar('select count(*)::int from contest_archives')
  const activeBefore = await rows('select id,status from players where pool_id=$1 order by id', [newPool])
  const activePicksBefore = await scalar('select count(*)::int from picks where pool_id=$1', [newPool])
  const result = await scalar(`select delete_archived_contest($1,'MADNESS Regular Season','Owner asked to remove it','admin')`, [oldPool])
  assert.equal(result.deleted, true); assert.equal(result.players, 3); assert.equal(result.picks, 5)
  const snap = await rows('select snapshot, reason from contest_archives where id=$1', [result.archive_id])
  assert.equal(snap[0].snapshot.kind, 'contest-deletion')
  assert.equal(snap[0].snapshot.players.length, 3); assert.equal(snap[0].snapshot.picks.length, 5)
  assert.equal(await scalar('select count(*)::int from players where pool_id=$1', [oldPool]), 0)
  assert.equal(await scalar('select count(*)::int from picks where pool_id=$1', [oldPool]), 0)
  assert.deepEqual(await rows('select id,status from players where pool_id=$1 order by id', [newPool]), activeBefore)
  assert.equal(await scalar('select count(*)::int from picks where pool_id=$1', [newPool]), activePicksBefore)
  assert.equal(await scalar('select count(*)::int from contest_archives where pool_id=$1', [legacyPool]), 1, 'other contests untouched')
  assert.equal(await scalar(`select count(*)::int from audit_log where event_type='contest-deleted' and details->>'pool_id'=$1`, [oldPool]), 1)
  const again = await scalar(`select delete_archived_contest($1,'MADNESS Regular Season','Owner asked to remove it','admin')`, [oldPool])
  assert.equal(again.deleted, false); assert.equal(again.already_empty, true)
  assert.equal(await scalar('select count(*)::int from contest_archives'), archivesBefore + 1, 'repeat writes nothing')
  assert.equal(await scalar(`select count(*)::int from audit_log where event_type='contest-deleted'`), 1)
  assert.equal((await scalar('select delete_archived_contest_preview($1)', [oldPool])).deletable, false)
  assert.equal(await scalar('select contest_history($1)', [oldPool]), null, 'a deleted contest is not served from its deletion snapshot')
  assert.deepEqual((await scalar('select contest_history_list()')).map((c) => c.id), [legacyPool])
  console.log(`PASS ${schema}: delete refuses active/non-archived/wrong name/empty reason; preview matches; snapshot first; others untouched; repeat is a no-op`)

  // Only service_role may call the new entry points.
  await db.exec('set role anon;')
  await fails(`select ${schema}.delete_archived_contest('${oldPool}','x','y','z')`, /permission denied/)
  await fails(`select ${schema}.contest_history('${oldPool}')`, /permission denied/)
  await db.exec('reset role;')
}

// 030 stays idempotent once several contests exist.
const settled = await rows(`select (select count(*)::int from public.players) a,(select count(*)::int from public.picks) b,(select count(*)::int from sandbox.players) c,(select count(*)::int from sandbox.picks) d`)
await db.exec(contests)
assert.deepEqual(await rows(`select (select count(*)::int from public.players) a,(select count(*)::int from public.picks) b,(select count(*)::int from sandbox.players) c,(select count(*)::int from sandbox.picks) d`), settled)

// A backup taken with several contests restores with pool_id intact.
const backup = await scalar('select public.contest_backup()')
assert.ok(backup.columns.players.some((c) => c.name === 'pool_id') && backup.columns.picks.some((c) => c.name === 'pool_id'))
const restored = await restoreCheck(backup)
assert.ok(restored.rows > 0)
console.log('PASS: re-applying 030 with several contests changes nothing; backup with pool_id restores in isolation')
await db.close()
