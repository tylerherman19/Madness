import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { restoreCheck } from './restore-check.mjs'
const db = new PGlite()
await db.exec(
  'create role anon;create role authenticated;create role service_role;create role authenticator;',
)
for (const file of (await readdir('supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort())
  await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
const scalar = async (sql, params = []) =>
  Object.values((await db.query(sql, params)).rows[0])[0]
for (const schema of ['public', 'sandbox']) {
  await db.exec(`set search_path=${schema},pg_catalog;update pools set season_year=2099,competition_mode='march-madness',pick_frequency='tournament-round';
 insert into players(full_name,email,pin_hash) select 'Entry '||n,'entry'||n||'@example.com','fixture' from generate_series(1,2000)n;
 insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values('00000000-0000-4000-8000-000000000001',1,'2099-03-19',2099,true,'2099-03-19T18:00:00Z');
 insert into games(slate_id,espn_event_id,home_team,away_team,tip_time,round_label) values('00000000-0000-4000-8000-000000000001','first','A','B','2099-03-19T18:00:00Z','1st Round'),('00000000-0000-4000-8000-000000000001','second','C','D','2099-03-19T19:00:00Z','1st Round');`)
  const player = await scalar(`select id from players order by id limit 1`),
    slate = '00000000-0000-4000-8000-000000000001',
    request = '00000000-0000-4000-8000-000000000010'
  const first = await scalar(`select save_pick($1,$2,'A',$3)`, [
    player,
    slate,
    request,
  ])
  assert.equal(first.version, 1)
  assert.equal(first.pick.team, 'A')
  assert.ok(first.deadline)
  assert.deepEqual(
    await scalar(`select save_pick($1,$2,'A',$3)`, [player, slate, request]),
    first,
  )
  await assert.rejects(
    db.query(`select save_pick($1,$2,'B',$3)`, [player, slate, request]),
    /Request ID reused/,
  )
  assert.equal(await scalar('select count(*)::int from pick_revisions'), 1)
  assert.equal(
    await scalar(
      "select status from notification_outbox where kind='pick-confirmation'",
    ),
    'held',
  )
  assert.equal(await scalar('select count(*)::int from rule_versions'), 1)
  await assert.rejects(
    db.exec("update pools set pick_frequency='every-game-day'"),
    /frozen/,
  )
  const edit = await scalar(
    `select save_pick($1,$2,'B',gen_random_uuid(),$3,$4)`,
    [player, slate, first.pick.id, first.pick.updated_at],
  )
  assert.equal(edit.version, 2)
  await assert.rejects(
    db.query(`select save_pick($1,$2,'C',gen_random_uuid(),$3,$4)`, [
      player,
      slate,
      first.pick.id,
      first.pick.updated_at,
    ]),
    /Stale/,
  )
  let counts = await scalar('select contest_counts()')
  assert.equal(counts.players, 2000)
  assert.equal(counts.partial, 1)
  assert.equal(counts.unpicked, 2000)
  const campaign = await scalar(
    `insert into email_campaigns(request_id,subject,message,audience,actor,period_ids,quota,provenance)values(gen_random_uuid(),'Fixture','Message','unpicked','fixture',array[$1::uuid],2,'test')returning id`,
    [slate],
  )
  assert.equal(await scalar('select expand_campaign($1,200)', [campaign]), 200)
  assert.equal(
    await scalar('select count(*)::int from campaign_recipients'),
    200,
  )
  for (let i = 0; i < 10; i++)
    await scalar('select expand_campaign($1,200)', [campaign])
  assert.equal(
    await scalar('select count(*)::int from campaign_recipients'),
    2000,
  )
  assert.equal(
    await scalar(
      'select count(*)::int from notification_outbox where campaign_id=$1',
      [campaign],
    ),
    2000,
  )
  await scalar('select expand_campaign($1,200)', [campaign])
  assert.equal(
    await scalar('select count(*)::int from campaign_recipients'),
    2000,
  )
  await db.exec(
    "select set_delivery_mode('test-recipients',array['entry1@example.com'],'fixture','Controlled test');",
  )
  assert.equal(
    (await db.query('select * from claim_notifications(50)')).rows.length,
    0,
    'Mode changes cannot release historical held mail',
  )
  // Historical campaign expanded after activation must still remain held.
  const historical = await scalar(
    `insert into email_campaigns(request_id,subject,message,audience,actor,provenance,created_at)values(gen_random_uuid(),'Old','Old test','all','fixture','test',now()-interval '1 day')returning id`,
  )
  await scalar('select expand_campaign($1,1)', [historical])
  assert.equal(
    await scalar(
      'select status from notification_outbox where campaign_id=$1',
      [historical],
    ),
    'held',
  )
  await db.exec(
    "select set_delivery_mode('live','{}','fixture','Fixture only; no provider connected');",
  )
  await db.exec(
    "insert into notification_outbox(event_key,kind,recipient,payload,priority)values('fresh','announcement','entry1@example.com','{}',80),('urgent','password-reset','entry2@example.com','{}',0)",
  )
  const claimed = (await db.query('select * from claim_notifications(1)')).rows
  if (schema === 'sandbox')
    assert.equal(claimed.length, 0, 'Sandbox never delivers')
  else {
    assert.equal(claimed[0].event_key, 'urgent')
    const n = claimed[0],
      frozen = {
        from: 'fixture',
        to: 'entry2@example.com',
        subject: 'one',
        text: 'same exact payload',
      }
    assert.deepEqual(
      await scalar('select prepare_notification($1,$2,$3)', [
        n.id,
        n.lease_token,
        JSON.stringify(frozen),
      ]),
      frozen,
    )
    await db.exec(
      `update notification_outbox set lease_until=now()-interval '1 second' where id='${n.id}'`,
    )
    assert.equal(
      await scalar(
        "select settle_notification($1,$2,'sent',null,'provider-lost')",
        [n.id, n.lease_token],
      ),
      false,
    )
    const recovered = (await db.query('select * from claim_notifications(1)'))
      .rows[0]
    assert.deepEqual(
      await scalar('select prepare_notification($1,$2,$3)', [
        n.id,
        recovered.lease_token,
        JSON.stringify({ ...frozen, text: 'different' }),
      ]),
      frozen,
    )
    // Callback before HTTP completion, duplicate and out-of-order events.
    await db.exec(
      "select record_provider_event('event-1','provider-id','email.delivered',now(),array['entry2@example.com']);",
    )
    assert.equal(
      await scalar(
        "select settle_notification($1,$2,'sent',null,'provider-id')",
        [n.id, recovered.lease_token],
      ),
      true,
    )
    await db.exec(
      "select record_provider_event('event-1','provider-id','email.delivered',now(),array['entry2@example.com']);select record_provider_event('event-2','provider-id','email.sent',now()-interval '1 hour',array['entry2@example.com']);",
    )
    assert.equal(
      await scalar(
        'select delivery_outcome from notification_outbox where id=$1',
        [n.id],
      ),
      'email.delivered',
    )
    assert.equal(await scalar('select count(*)::int from provider_events'), 2)
    await db.exec(
      "select record_provider_event('event-3','provider-id','email.bounced',now(),array['entry2@example.com']);",
    )
    assert.equal(
      await scalar(
        'select delivery_outcome from notification_outbox where id=$1',
        [n.id],
      ),
      'email.bounced',
    )
    assert.equal(
      await scalar('select count(*)::int from email_suppressions'),
      1,
    )
    const normal = (await db.query('select * from claim_notifications(1)'))
      .rows[0]
    await db.query(
      "update notification_outbox set first_attempt_at=now()-interval '25 hours',lease_until=now()-interval '1 second' where id=$1",
      [normal.id],
    )
    await db.exec('select * from claim_notifications(10)')
    assert.equal(
      await scalar('select status from notification_outbox where id=$1', [
        normal.id,
      ]),
      'review',
    )
    assert.equal(
      await scalar("select retry_notification($1,'fixture','Reviewed retry')", [
        normal.id,
      ]),
      false,
    )
    assert.equal(await scalar('select reserve_email_slot()'), true)
    assert.equal(await scalar('select reserve_email_slot()'), false)
  }
  const findings = await scalar('select reconcile_contest()')
  assert.equal(findings.missing_notification_intents, 0)
  assert.equal(findings.counts.players, 2000)
  const token = await scalar("select claim_operation('recurring:test',10)")
  assert.ok(token)
  assert.equal(
    await scalar(
      "select finish_recurring_operation('recurring:test',$1,60,'{\"processed\":200}')",
      [token],
    ),
    true,
  )
  assert.equal(
    await scalar("select claim_operation('recurring:test',10)"),
    null,
  )
  await db.exec(
    "update operation_runs set next_attempt_at=now()-interval '2 hours' where key='recurring:test'",
  )
  assert.ok(
    await scalar("select claim_operation('recurring:test',10)"),
    'Late invocation catches up based on durable time',
  )
  await db.exec("update games set result='home_win' where espn_event_id='first'")
  assert.equal(await scalar("select mark_results_graded(jsonb_build_array(jsonb_build_object('id',(select id from games where espn_event_id='first'),'result','home_win')))"),0)
  await db.query("select grade_pick_loss($1,1,'Fixture final')",[first.pick.id])
  assert.equal(await scalar("select mark_results_graded(jsonb_build_array(jsonb_build_object('id',(select id from games where espn_event_id='first'),'result','home_win')))"),1)
  await db.exec("update games set result='away_win' where espn_event_id='first'")
  assert.equal(await scalar("select graded_at from games where espn_event_id='first'"),null)
  assert.equal(await scalar("select count(*)::int from incidents where key like 'result-correction:%'"),1)
  await db.exec("update games set result='home_win',round_label='National Championship';update slates set auto_assign_completed_at=now() where is_active")
  assert.equal(await scalar('select complete_tournament($1)',[slate]),true)
  assert.equal(await scalar('select status from pools where is_active'),'completed')
  assert.equal(await scalar('select count(*)::int from slates where is_active'),0)
  await db.exec('set role anon;')
  await assert.rejects(
    db.exec(`select * from ${schema}.pick_revisions`),
    /permission denied/,
  )
  await assert.rejects(
    db.query(`select ${schema}.save_pick($1,$2,'A',gen_random_uuid())`, [
      player,
      slate,
    ]),
    /permission denied/,
  )
  await db.exec('reset role')
  console.log(
    `PASS ${schema}: 2000 entries, partial quotas, campaign resume/dedup, transactional receipts, stale edits, rules freeze, disabled backlog, lease fencing, provider event ordering, durable due times and authorization`,
  )
}
await db.exec('set search_path=public,pg_catalog')
const backup = await scalar('select contest_backup()')
const restored = await restoreCheck(backup)
assert.ok(restored.tables >= 22)
console.log(
  `PASS full-schema isolated restore: ${restored.tables} tables, ${restored.rows} rows; all row digests match`,
)
await db.close()
