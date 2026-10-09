import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;');
for (const file of (await fs.readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await fs.readFile(`supabase/migrations/${file}`, 'utf8'));
const sql = text => db.exec(text);
const scalar = async text => Object.values((await db.query(text)).rows[0])[0];
const fails = async (text, match) => { await assert.rejects(sql(text), match); };
for (const schema of ['public', 'sandbox']) {
 await sql(`set search_path to ${schema}; update pools set season_year=2027;`);
 if (schema === 'sandbox') await sql(`update clock set simulated_now=null;`);
 await sql(`insert into players(id, full_name, email, pin_hash) values ('00000000-0000-4000-8000-000000000001', 'Player', 'p@example.test', 'test');
 insert into slates(id, slate_number, slate_date, season_year, locks_at, is_active) values
 ('00000000-0000-4000-8000-000000000002', 1, current_date+1, 2027, now()+interval '1 day', true),
 ('00000000-0000-4000-8000-000000000003', 2, current_date+2, 2027, now()+interval '2 days', false),
 ('00000000-0000-4000-8000-000000000004', 3, current_date+100, 2027, now()+interval '100 days', false);
 insert into games(slate_id, espn_event_id, home_team, away_team, tip_time, round_label) values
 ('00000000-0000-4000-8000-000000000002', 'one', 'A', 'B', now()+interval '1 day', '1st Round'),
 ('00000000-0000-4000-8000-000000000003', 'two', 'C', 'D', now()+interval '2 days', '2nd Round'),
 ('00000000-0000-4000-8000-000000000004', 'three', 'E', 'F', now()+interval '100 days', '1st Round');
 insert into picks(player_id, slate_id, team) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'A');`);
 await fails(`insert into picks(player_id, slate_id, team) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'B')`, /quota/);
 assert.equal(await scalar(`select count(*)::int from audit_log where event_type='pick-submitted'`),1);
 await sql(`update games set result='away_win' where espn_event_id='one'; update players set status='eliminated', elimination_reason='lost', elimination_slate=1;`);
 await fails(`select restore_player('00000000-0000-4000-8000-000000000001', '')`, /reason/);
 await sql(`select restore_player('00000000-0000-4000-8000-000000000001', 'Dispute settled', 'test-admin');`);
 assert.equal(await scalar(`select loss_excused from picks`), true);
 const pickId = await scalar('select id from picks');
 assert.equal(await scalar(`select grade_pick_loss('${pickId}', 1, 'stale grading')`),false);
 assert.equal(await scalar(`select status from players`),'alive');
 assert.equal(await scalar(`select count(*)::int from audit_log where event_type='pick-changed'`),0);
 assert.equal(await scalar(`select status from notification_outbox where kind='elimination'`),'review');
 await sql(`insert into picks(player_id, slate_id, team, auto_assigned) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','C',true);`);
 await sql(`update games set result='away_win' where espn_event_id='two';`);
 await fails(`insert into picks(player_id, slate_id, team) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','E')`, /previous pick lost/);
 console.log(`PASS ${schema}: restoration allows next manual/automatic pick; new losses still block; one atomic audit`);
 await sql(`insert into players(full_name,email,pin_hash) select 'Reminder '||n, 'r'||n||'@example.test','test' from generate_series(1,1200) n;`);
 const ids = `array(select id from players)`;
 const queue = `select queue_pick_reminders('00000000-0000-4000-8000-000000000002',${ids},array['00000000-0000-4000-8000-000000000002'::uuid],1,now()+interval '1 day','Tomorrow')`;
 assert.equal(await scalar(queue),1200);
 assert.equal(await scalar(queue),0);
 await sql(`update slates set locks_at=now()-interval '1 second' where id='00000000-0000-4000-8000-000000000002';`);
 assert.equal(await scalar(queue),0);
 console.log(`PASS ${schema}: 1200 reminders queued, duplicates suppressed, post-deadline queue blocked`);
 await sql(`insert into revoked_sessions(token_hash,expires_at) values('hash',now()+interval '1 day'); set role anon;`);
 await fails(`select * from ${schema}.revoked_sessions`, /permission denied/);
 await fails(`select * from ${schema}.contest_archives`, /permission denied/);
 await fails(`select ${schema}.restore_player('00000000-0000-4000-8000-000000000001','unauthorized')`, /permission denied/);
 await sql('reset role;');
 const pool = await scalar(`select id from pools where is_active`);
 await fails(`select start_fresh_tournament('${pool}','00000000-0000-4000-8000-000000000002','March','test-admin')`, /future deadline/);
 assert.equal(await scalar('select count(*)::int from players'),1201);
 const archive = await scalar(`select start_fresh_tournament('${pool}','00000000-0000-4000-8000-000000000004','March fresh entries','test-admin')`);
 assert.equal(await scalar('select count(*)::int from players'),0);
 assert.equal(await scalar('select count(*)::int from picks'),0);
 assert.equal(await scalar(`select jsonb_array_length(snapshot->'players') from contest_archives where id='${archive}'`),1201);
 assert.equal(await scalar(`select jsonb_array_length(snapshot->'picks') from contest_archives where id='${archive}'`),2);
 assert.equal(await scalar('select competition_mode from pools where is_active'),'march-madness');
 assert.equal(await scalar('select pick_frequency from pools where is_active'),'tournament-round');
 assert.equal(await scalar('select id from slates where is_active'),'00000000-0000-4000-8000-000000000004');
 await fails(`select start_fresh_tournament('${pool}','00000000-0000-4000-8000-000000000004','double click','test-admin')`, /active contest changed/);
 console.log(`PASS ${schema}: archive matches all 1201 entries and 2 picks; new pool opens; invalid/repeated rollover leaves state unchanged; archive/session RLS blocks anon`);
}
await db.close();
