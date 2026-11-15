// INT-06 and SEC-08 regressions for migration 036, on a disposable database.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(`supabase/migrations/${f}`, 'utf8'))
// Applying 036 again is harmless.
await db.exec(await readFile('supabase/migrations/036_seed_rule_and_append_only_audit.sql', 'utf8'))

const P = '30000000-0000-4000-8000-000000000001', R = '40000000-0000-4000-8000-000000000001', T = '40000000-0000-4000-8000-000000000002'
await db.exec(`set session_replication_role = replica;
delete from public.picks; delete from public.games; delete from public.slates; delete from public.players;
insert into public.players (id, full_name, email, pin_hash) values ('${P}','Seed Tester','seed@example.test','x');
insert into public.slates (id, slate_number, slate_date, season_year, is_active, locks_at) values
 ('${R}', 1, '2099-01-01', 2099, false, now() + interval '1 day'), ('${T}', 2, '2099-03-20', 2099, false, now() + interval '2 days');
insert into public.games (slate_id, espn_event_id, home_team, away_team, home_seed, away_seed, round_label, tip_time) values
 ('${R}','r1','RANKED','OTHER',5,null,null, now() + interval '1 day'),
 ('${T}','t1','SEEDED','LOWER',3,14,'1st Round', now() + interval '2 days');
set session_replication_role = origin;`)
// Ordinary inserts go through every trigger except pick integrity, which is
// not what this test is about; disable just that one for the insert.
await db.exec(`alter table public.picks disable trigger user; alter table public.picks enable trigger picks_tournament_seed_only;
insert into public.picks (player_id, slate_id, team, seed) values ('${P}','${R}','RANKED',5), ('${P}','${T}','SEEDED',3);
alter table public.picks enable trigger user;`)
const seeds = Object.fromEntries((await db.query('select team, seed from public.picks')).rows.map(r => [r.team, r.seed]))
assert.equal(seeds.RANKED, null, 'an AP rank is never stored as a seed')
assert.equal(seeds.SEEDED, 3, 'a tournament seed is kept')
console.log('PASS INT-06: regular-season pick stores no seed; tournament pick keeps its seed')

await db.exec(`insert into public.audit_log (event_type, actor, message) values ('pick-submitted','system','kept')`)
await assert.rejects(db.exec(`update public.audit_log set message = 'changed'`), /append-only/)
await assert.rejects(db.exec(`delete from public.audit_log`), /append-only/)
assert.equal((await db.query(`select count(*)::int n from public.audit_log where message = 'kept'`)).rows[0].n, 1)
console.log('PASS SEC-08: audit_log rows cannot be updated or deleted')
await db.exec(`set session_replication_role = replica; delete from public.audit_log; set session_replication_role = origin;`)
console.log('PASS isolated restore (replica role) can still clear audit_log in a disposable database')
