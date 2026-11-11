import {PGlite} from '@electric-sql/pglite'
import {readFile,readdir} from 'node:fs/promises'
import assert from 'node:assert/strict'
const db=new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
const files=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()
for(const f of files) await db.exec(await readFile('supabase/migrations/'+f,'utf8'))
console.log('PASS repo-only database: all migrations incl. 034 apply (no app_private, skipped)')
// production-like: old mobile helpers exist
await db.exec(`create schema app_private;
create function app_private.slate_lock_time(p_slate_id uuid) returns timestamptz language sql stable security definer set search_path='' as $$ select coalesce(s.locks_at,(select min(g.tip_time) from public.games g where g.slate_id=s.id and not g.time_tbd)) from public.slates s where s.id=p_slate_id $$;
create function app_private.slate_is_revealed(p_slate_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select coalesce(app_private.slate_lock_time(p_slate_id)<=now(),false) or exists(select 1 from public.games g where g.slate_id=p_slate_id and g.status_state<>'pre') $$;
set session_replication_role=replica;
insert into public.slates(id,slate_number,slate_date,season_year,is_active,locks_at) values('00000000-0000-4000-8000-0000000000aa',900,'2098-01-01',2098,false,now()+interval '2 hours');
insert into public.games(slate_id,espn_event_id,home_team,away_team,tip_time,result,status_state) values('00000000-0000-4000-8000-0000000000aa','x1','A','B',now()+interval '3 hours','pending','post');
set session_replication_role=origin;`)
const q=async()=>(await db.query(`select app_private.slate_is_revealed('00000000-0000-4000-8000-0000000000aa') r`)).rows[0].r
assert.equal(await q(),true); console.log('PASS old rule leaks: a postponed (post) game reveals picks before lock')
const m=await readFile('supabase/migrations/034_mobile_reveal_rule.sql','utf8')
await db.exec(m); await db.exec(m)
assert.equal(await q(),false); console.log('PASS 034 (applied twice): ESPN status no longer reveals before lock')
await db.exec(`set session_replication_role=replica;update public.games set tip_time=now()-interval '1 minute' where espn_event_id='x1';set session_replication_role=origin;`)
assert.equal(await q(),true); console.log('PASS earlier tip than stored lock reveals (least of lock and first tip)')
