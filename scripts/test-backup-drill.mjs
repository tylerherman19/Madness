// Backup restore drill (audit 7.5), local only. Builds a seeded fixture contest
// in an in-memory PostgreSQL (PGlite) from the migrations, takes a backup with
// the same contest_backup() function production uses, encrypts it to disk,
// reads it back, restores it into a fresh empty database built from the
// migrations, and verifies: per-table row counts and digests against the
// source database, password authentication for a restored player, contest and
// standings counts, and that admin SQL functions run. Never touches a live
// database: there is no connection argument.
import { PGlite } from '@electric-sql/pglite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { decryptBackup, encryptBackup, snapshotDigest } from './backup.mjs'
import { restoreCheck } from './restore-check.mjs'

const migrated = async () => {
 const db = new PGlite()
 await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
 for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
 return db
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0]
const tableRows = async (db, table) => (await one(db, `select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) as rows from public.${table} r`)).rows
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// Standings inputs, computed the same way on the source and the restored copy.
const STANDINGS = `select p.id player_id, p.full_name, p.status,
  count(k.id) filter (where (k.team=g.home_team and g.result='home_win') or (k.team=g.away_team and g.result='away_win'))::int slates_survived,
  coalesce(sum(k.seed),0)::int seed_total
 from public.players p left join public.picks k on k.player_id=p.id left join public.games g on g.id=k.game_id
 group by p.id order by p.id`

const source = await migrated()
const PASSWORD = 'DrillPass123!'
const hash = await bcrypt.hash(PASSWORD, 4)
const pool = (await one(source, 'select id from public.pools where is_active')).id
await source.exec(`set session_replication_role=replica;
 update public.pools set name='Drill contest',season_year=2026,competition_mode='regular-season',pick_frequency='every-game-day',starts_on='2026-11-01' where id='${pool}';
 insert into public.pools(id,name,competition_mode,status,season_year,is_active) values('${uuid(900)}','Archived drill contest','regular-season','archived',2025,false);
 insert into public.teams(abbr,display_name,short_name,espn_id) values('A','Alpha','Alpha','1'),('B','Bravo','Bravo','2'),('C','Charlie','Charlie','3'),('D','Delta','Delta','4');
 insert into public.slates(id,slate_number,slate_date,season_year,is_active,locks_at) values
  ('${uuid(1)}',1,'2026-11-01',2026,false,'2026-11-01T18:00:00Z'),('${uuid(2)}',2,'2026-11-02',2026,false,'2026-11-02T18:00:00Z'),('${uuid(3)}',3,'2026-11-03',2026,true,'2099-11-03T18:00:00Z');
 insert into public.games(id,slate_id,espn_event_id,home_team,away_team,home_seed,away_seed,tip_time,result,status_state,home_score,away_score) values
  ('${uuid(11)}','${uuid(1)}','e1','A','B',1,8,'2026-11-01T18:00:00Z','home_win','post',70,60),
  ('${uuid(12)}','${uuid(1)}','e2','C','D',4,5,'2026-11-01T20:00:00Z','away_win','post',55,61),
  ('${uuid(21)}','${uuid(2)}','e3','A','C',1,4,'2026-11-02T18:00:00Z','away_win','post',50,52),
  ('${uuid(22)}','${uuid(2)}','e4','B','D',8,5,'2026-11-02T20:00:00Z','home_win','post',66,64),
  ('${uuid(31)}','${uuid(3)}','e5','A','D',1,5,'2099-11-03T18:00:00Z','pending','pre',null,null);`)
for (let i = 0; i < 6; i++) {
 await source.query(`insert into public.players(id,full_name,email,pin_hash,paid,status,elimination_slate,phone) values($1,$2,$3,$4,$5,$6,$7,$8)`,
  [uuid(100 + i), `Drill Player ${i}${i === 2 ? " O'Brien 🏀" : ''}`, `drill${i}@example.test`, hash, i % 2 === 0, i < 4 ? 'alive' : 'eliminated', i < 4 ? null : 2, `60855500${i}0`])
}
await source.exec(`set session_replication_role=replica;
 insert into public.picks(player_id,slate_id,game_id,team,seed) values
  ('${uuid(100)}','${uuid(1)}','${uuid(11)}','A',1),('${uuid(100)}','${uuid(2)}','${uuid(21)}','C',4),('${uuid(100)}','${uuid(3)}','${uuid(31)}','D',5),
  ('${uuid(101)}','${uuid(1)}','${uuid(12)}','D',5),('${uuid(101)}','${uuid(2)}','${uuid(22)}','B',8),
  ('${uuid(102)}','${uuid(1)}','${uuid(11)}','A',1),('${uuid(102)}','${uuid(2)}','${uuid(22)}','B',8),
  ('${uuid(103)}','${uuid(1)}','${uuid(12)}','D',5),('${uuid(103)}','${uuid(2)}','${uuid(21)}','C',4),
  ('${uuid(104)}','${uuid(1)}','${uuid(11)}','A',1),('${uuid(104)}','${uuid(2)}','${uuid(21)}','C',4),
  ('${uuid(105)}','${uuid(1)}','${uuid(11)}','B',8);
 insert into public.audit_log(event_type,actor,player_id,player_name,message,details) values
  ('player-signed-up','player','${uuid(100)}','Drill Player 0','Signed up','{"source":"drill"}'),
  ('player-eliminated','system','${uuid(104)}','Drill Player 4','Eliminated on slate 2',null),
  ('result-set','admin',null,null,'Result recorded','{"game":"e3"}');
 insert into public.contest_archives(pool_id,snapshot,reason) values('${uuid(900)}','{"players":[{"full_name":"Archived entrant"}],"picks":[]}','Drill archive of the previous contest');
 insert into public.revoked_sessions(token_hash,expires_at) values('${'b'.repeat(64)}',now()+interval '1 day');
 insert into public.notification_outbox(event_key,kind,player_id,payload) values('drill:reminder','reminder','${uuid(101)}','{}');
 set session_replication_role=origin;`)

const sourceCounts = await one(source, 'select public.contest_counts() as value')
const sourceStandings = (await source.query(STANDINGS)).rows
const snapshot = (await one(source, 'select public.contest_backup() as value')).value
const tables = Object.keys(snapshot.tables)
const sourceDigest = {}
for (const table of tables) sourceDigest[table] = snapshotDigest({ tables: { [table]: await tableRows(source, table) } })[table]
await source.close()
for (const table of ['players', 'picks', 'games', 'slates', 'pools', 'audit_log', 'contest_archives', 'teams']) assert.ok(snapshot.tables[table].length > 0, `fixture seeds ${table}`)
assert.ok(snapshot.columns.players.some(column => column.name === 'pin_reset_used_at'), 'columns added by later migrations are captured')

// Encrypt to disk and read back, as the workflow does.
const key = randomBytes(32).toString('base64')
const dir = await mkdtemp(join(tmpdir(), 'madness-drill-'))
const file = join(dir, 'backup-public.json.enc')
try {
 await writeFile(file, JSON.stringify(encryptBackup(snapshot, key)), { mode: 0o600 })
 const bytes = await readFile(file, 'utf8')
 assert.equal(bytes.includes('drill0@example.test'), false, 'archive holds no plaintext')
 const restored = decryptBackup(JSON.parse(bytes), key)

 const result = await restoreCheck(restored, { inspect: async db => {
  await db.exec('set session_replication_role=origin')
  for (const table of tables) {
   const rows = await tableRows(db, table)
   assert.deepEqual(snapshotDigest({ tables: { [table]: rows } })[table], sourceDigest[table], `${table}: restored count and digest equal the source database`)
  }
  // A restored participant signs in with their stored password hash.
  const player = await one(db, `select pin_hash from public.players where email='drill2@example.test'`)
  assert.equal(await bcrypt.compare(PASSWORD, player.pin_hash), true)
  assert.equal(await bcrypt.compare('WrongPass123!', player.pin_hash), false)
  // Contest counts and standings inputs compute identically.
  assert.deepEqual((await one(db, 'select public.contest_counts() as value')).value, sourceCounts.value)
  assert.deepEqual((await db.query(STANDINGS)).rows, sourceStandings)
  assert.equal(sourceStandings.filter(row => row.status === 'alive').length, 4)
  const archive = await one(db, `select count(*)::int n from public.contest_archives a join public.pools p on p.id=a.pool_id where p.status='archived'`)
  assert.equal(archive.n, 1, 'contest archive keeps its contest')
  // Admin SQL functions run against the restored data.
  await db.query('select public.active_pick_requirement()')
  await db.query('select public.reconcile_contest()')
  await db.query('select public.operation_retention(false)')
  // Account recovery works after a restore (migration 032).
  const tokenHash = createHash('sha256').update('drill-token').digest('hex')
  assert.equal((await one(db, `select public.issue_password_reset_link($1,$2,now()+interval '1 hour','drill') as value`, [uuid(102), tokenHash])).value.status, 'ok')
  const newHash = await bcrypt.hash('RestoredPass123!', 4)
  assert.equal((await one(db, 'select public.consume_password_reset_link($1,$2) as value', [tokenHash, newHash])).value.status, 'ok')
  assert.equal((await one(db, 'select public.consume_password_reset_link($1,$2) as value', [tokenHash, newHash])).value.status, 'used')
  return { tables: tables.length }
 } })
 assert.equal(result.inspected.tables, tables.length)
 assert.equal(result.tables, tables.length)
 console.log(`PASS backup restore drill: ${result.tables} tables and ${result.rows} rows restored into a fresh database; digests match the source, a restored player authenticates, contest counts and standings match, admin functions run`)
} finally { await rm(dir, { recursive: true, force: true }) }
