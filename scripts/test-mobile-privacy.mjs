// INT-01 / SEC-07 regression: the mobile read functions must not let one
// entrant's unrevealed pick move another entrant's visible figures, and only
// signed-in users who own an entry may read them.
//
// Builds a disposable in-memory database: repository migrations, then the
// production mobile schema (scripts/fixtures/mobile-native-app-020.sql, the
// native-ios source that production matches), then 034 as production has it,
// then 035. Queries run as the `authenticated` role with a JWT subject, so
// grants and SECURITY DEFINER behaviour are exercised, not superuser access.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role; create role authenticator;
create schema auth; grant usage on schema auth to authenticated, anon;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to authenticated, anon;`)
for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
  if (f.startsWith('035')) continue
  await db.exec(await readFile(`supabase/migrations/${f}`, 'utf8'))
}
await db.exec(await readFile('scripts/fixtures/mobile-native-app-020.sql', 'utf8'))
// Production state: 034 applied after the mobile schema; production's
// get_pool_summary already lets an owner count their own test entry.
await db.exec(await readFile('supabase/migrations/034_mobile_reveal_rule.sql', 'utf8'))
await db.exec(`create or replace function public.get_pool_summary()
returns table (total_entries int, alive_entries int, paid_entries int)
language sql stable security definer set search_path = '' as $$
  select count(*)::int, count(*) filter (where status = 'alive')::int, count(*) filter (where paid)::int
  from public.players where auth.uid() is not null
  and (not app_private.is_test_email(email) or id = any (app_private.my_player_ids())) $$;`)

const U = { a: '00000000-0000-4000-8000-00000000000a', b: '00000000-0000-4000-8000-00000000000b', c: '00000000-0000-4000-8000-00000000000c' }
const P = { a: '10000000-0000-4000-8000-00000000000a', b: '10000000-0000-4000-8000-00000000000b' }
const S = { d0: '20000000-0000-4000-8000-000000000000', d1: '20000000-0000-4000-8000-000000000001', d2: '20000000-0000-4000-8000-000000000002' }
await db.exec(`set session_replication_role = replica;
delete from public.picks; delete from public.games; delete from public.slates; delete from public.players;
insert into auth.users (id, email) values ('${U.a}','a@example.com'),('${U.b}','b@example.com'),('${U.c}','c@example.com');
insert into public.players (id, full_name, email, pin_hash, status, paid) values
 ('${P.a}','Avery','a@example.com','x','alive',true), ('${P.b}','Blake','b@example.com','x','alive',true);
insert into public.player_accounts (user_id, player_id) values ('${U.a}','${P.a}'),('${U.b}','${P.b}');
insert into public.slates (id, slate_number, slate_date, season_year, is_active, locks_at) values
 ('${S.d0}', 1, '2099-03-01', 2099, false, now() - interval '2 days'),
 ('${S.d1}', 2, '2099-03-02', 2099, true,  now() + interval '2 hours'),
 ('${S.d2}', 3, '2099-03-03', 2099, false, now() + interval '26 hours');
insert into public.games (slate_id, espn_event_id, home_team, away_team, tip_time, result, status_state, time_tbd) values
 ('${S.d0}','e0','Alpha','Beta', now() - interval '2 days','home_win','post',false),
 ('${S.d0}','e0b','Gamma','Delta', now() - interval '2 days','home_win','post',false),
 ('${S.d1}','e1','Echo','Fox', now() + interval '2 hours','pending','pre',false),
 ('${S.d1}','e1b','Golf','Hotel', now() + interval '2 hours','pending','pre',false),
 ('${S.d2}','e2','India','Juliet', now() + interval '26 hours','pending','pre',false);
insert into public.picks (player_id, slate_id, team, seed) values
 ('${P.a}','${S.d0}','Alpha',4), ('${P.b}','${S.d0}','Gamma',5);
set session_replication_role = origin;`)

const as = async (user, sql) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user ?? ''}', false);`)
  try { return (await db.query(sql)).rows } finally { await db.exec('reset role;') }
}
const standings = user => as(user, 'select player_id, days_survived, seed_total, is_mine from public.get_standings()')
const row = (rows, id) => { const r = rows.find(x => x.player_id === id); return r && { days: r.days_survived, seed: r.seed_total } }
const order = rows => rows.map(r => r.player_id).join(',')
const pick = (player, slate, team, seed) => db.exec(`set session_replication_role = replica;
insert into public.picks (player_id, slate_id, team, seed) values ('${player}','${slate}','${team}',${seed});
set session_replication_role = origin;`)
const reveal = slate => db.exec(`set session_replication_role = replica;
update public.slates set locks_at = now() - interval '1 minute' where id = '${slate}';
update public.games set tip_time = now() - interval '1 minute' where slate_id = '${slate}';
set session_replication_role = origin;`)

// 1. The production definition leaks (red before the fix).
const before = await standings(U.a)
assert.deepEqual(row(before, P.b), { days: 1, seed: 5 })
await pick(P.b, S.d1, 'Echo', 3)
assert.deepEqual(row(await standings(U.a), P.b), { days: 2, seed: 8 })
console.log('PASS production get_standings leaks: an unrevealed current-day pick moved a rival\'s seed_total 5 -> 8')
await db.exec(`delete from public.picks where slate_id = '${S.d1}'`)

// 2. Apply 035 twice (idempotent), then re-run the same scenario.
const m035 = await readFile('supabase/migrations/035_mobile_read_privacy.sql', 'utf8')
await db.exec(m035); await db.exec(m035)

const base = await standings(U.a)
assert.deepEqual(row(base, P.b), { days: 1, seed: 5 })
await pick(P.b, S.d1, 'Echo', 3)
const afterCurrent = await standings(U.a)
assert.deepEqual(row(afterCurrent, P.b), row(base, P.b), 'current-day hidden pick must not move totals')
assert.equal(order(afterCurrent), order(base), 'ordering unchanged')
console.log('PASS current day: rival\'s unrevealed pick leaves days_survived, seed_total and order unchanged')
assert.deepEqual(row(await standings(U.b), P.b), { days: 2, seed: 8 })
console.log('PASS the owner still sees their own unrevealed pick in their own row')

// Early next-day pick: day 1 locks (revealed), B picks day 2 before it locks.
await reveal(S.d1)
const dayOneRevealed = await standings(U.a)
assert.deepEqual(row(dayOneRevealed, P.b), { days: 2, seed: 8 }, 'revealed day counts')
await pick(P.b, S.d2, 'India', 9)
const afterEarly = await standings(U.a)
assert.deepEqual(row(afterEarly, P.b), row(dayOneRevealed, P.b), 'early next-day pick must not move totals')
assert.equal(order(afterEarly), order(dayOneRevealed))
console.log('PASS early next-day: rival\'s pick on an unlocked later day leaves totals and order unchanged')
await reveal(S.d2)
assert.deepEqual(row(await standings(U.a), P.b), { days: 3, seed: 17 })
console.log('PASS once that day is revealed it is counted (the fix hides, it does not drop)')

// Pick history and slate view keep hiding the team before reveal.
await pick(P.a, S.d2, 'Juliet', 2) // A's own pick, day 2 now revealed
await db.exec(`set session_replication_role = replica; update public.slates set locks_at = now() + interval '1 hour' where id = '${S.d2}'; update public.games set tip_time = now() + interval '1 hour' where slate_id = '${S.d2}'; set session_replication_role = origin;`)
const hist = await as(U.a, `select slate_id from public.get_entry_picks('${P.b}')`)
assert.ok(!hist.some(r => r.slate_id === S.d2), 'unrevealed day withheld from rival history')
const slate = await as(U.a, `select player_id, team from public.get_slate_picks('${S.d2}')`)
assert.equal(slate.find(r => r.player_id === P.b)?.team ?? null, null)
assert.equal(slate.find(r => r.player_id === P.a)?.team, 'Juliet')
console.log('PASS get_entry_picks / get_slate_picks still withhold a rival\'s unrevealed team and show the caller\'s own')

// SEC-07: a signed-in user with no linked entry, and a signed-out caller.
for (const fn of ['select * from public.get_standings()', `select * from public.get_entry_picks('${P.b}')`, `select * from public.get_slate_picks('${S.d1}')`]) {
  for (const user of [U.c, null]) {
    await assert.rejects(as(user, fn), e => e.code === '28000', `${fn} as ${user ?? 'anonymous'}`)
  }
}
assert.deepEqual(await as(U.c, 'select * from public.get_pool_summary()'), [{ total_entries: 0, alive_entries: 0, paid_entries: 0 }])
assert.equal((await as(U.a, 'select * from public.get_pool_summary()'))[0].total_entries, 2)
console.log('PASS SEC-07: unlinked signed-in users get 28000 (or zero counts); linked users unaffected')

// Repo-only database: 035 is skipped cleanly.
const bare = new PGlite()
await bare.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await bare.exec(await readFile(`supabase/migrations/${f}`, 'utf8'))
assert.equal((await bare.query(`select to_regprocedure('public.get_standings()') is null as missing`)).rows[0].missing, true)
console.log('PASS repo-only database: all migrations incl. 035 apply (no mobile schema, skipped)')
