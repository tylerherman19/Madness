import {PGlite} from '@electric-sql/pglite'
import {readFile,readdir} from 'node:fs/promises'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {encryptBackup,decryptBackup,fetchBackupSnapshot} from './backup.mjs'
import {restoreCheck} from './restore-check.mjs'
// Verify schema routing and identity before the archive/encryption boundary.
const backupCalls=[]
const backupRequest=async(url,options)=>{
 backupCalls.push({url,options})
 return {ok:true,json:async()=>({schema:options.headers['Content-Profile'],tables:{}})}
}
const backupConfig={url:'https://fixture.supabase.test',serviceKey:'fixture-service-role-key'}
assert.equal((await fetchBackupSnapshot(backupConfig,backupRequest)).schema,'public')
assert.equal((await fetchBackupSnapshot({...backupConfig,schema:'sandbox'},backupRequest)).schema,'sandbox')
assert.deepEqual(backupCalls.map(call=>call.options.headers['Content-Profile']),['public','sandbox'])
assert.ok(backupCalls.every(call=>call.url==='https://fixture.supabase.test/rest/v1/rpc/contest_backup' && call.options.method==='POST'))
const countBeforeInvalid=backupCalls.length
for(const schema of ['', 'PUBLIC', 'private', 'public,sandbox']) {
 await assert.rejects(fetchBackupSnapshot({...backupConfig,schema},backupRequest),/must be public or sandbox/)
}
assert.equal(backupCalls.length,countBeforeInvalid,'Unsupported schemas must not make a request')
for(const responseSchema of ['public',undefined]) {
 await assert.rejects(fetchBackupSnapshot({...backupConfig,schema:'sandbox'},async()=>({ok:true,json:async()=>({schema:responseSchema,tables:{}})})),/schema mismatch/)
}
console.log('PASS backup schema: public default, explicit sandbox profile, invalid schema rejection and response identity check')
const db=new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql') && f < '025_').sort()) await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
await db.exec(await readFile('supabase/migrations/024_operations.sql','utf8'))
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0]
const fails=async(sql,pattern)=>assert.rejects(db.exec(sql),pattern)
// Exercise the real assignment coordinator without a Next server or network.
// Only framework side effects/provider calls are replaced; claims and player
// writes still use the migrated PostgreSQL functions below.
async function loadTs(file,dependencies={}) {
 const exports={}
 const code=ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','exports',code)(name=>{
  if(name in dependencies)return dependencies[name]
  throw new Error(`Unexpected test dependency: ${name}`)
 },exports)
 return exports
}
const operations=await loadTs('src/lib/operations.ts',{'server-only':{}})
const deadline=await loadTs('src/lib/deadline.ts')
const competition=await loadTs('src/lib/competition.ts')
// Match PostgREST's JSON date/timestamp representation rather than Date objects.
const rows=async table=>(await db.query(`select to_jsonb(r) as data from ${table} r`)).rows.map(row=>row.data)
const {runAutoAssignNow}=await loadTs('src/lib/autoAssign.ts',{
 'server-only':{},'./revalidateContest':{revalidateContest(){}},'./deadline':deadline,
 './pool':{getPoolConfig:async()=>(await rows('pools')).find(row=>row.is_active)},
 './competition':competition,'./espn':{fetchApRankings:async()=>({})},'./operations':operations,
 './audit':{logAudit:async()=>{}},'./alerts':{reportFailure:async()=>{}},
 './db':{selectAllIn:async() => rows('picks')},
 './seasonData':{
  loadAll:async(_client,table)=>rows(table),
  loadGamesForSlates:async(_client,ids)=>(await rows('games')).filter(row=>ids.includes(row.slate_id)),
  loadPicksForSlates:async(_client,ids)=>(await rows('picks')).filter(row=>ids.includes(row.slate_id)),
 },
})
function assignmentClient(failPlayer) {
 return {
  from(table) {
   const filters=[]
   const read=async()=>({data:(await rows(table)).filter(row=>filters.every(([key,value])=>row[key]===value)),error:null})
   const query={select(){return query},eq(key,value){filters.push([key,value]);return query},
    async maybeSingle(){const result=await read();return {...result,data:result.data[0]??null}},
    async single(){return query.maybeSingle()},then(resolve,reject){return read().then(resolve,reject)}}
   return query
  },
  async rpc(name,args) {
   if(name==='apply_assignment' && args.p_player_id===failPlayer)return {data:null,error:{message:'Fixture write failed for private@example.test'}}
   const entries=Object.entries(args)
   const parameters=entries.map(([key,value])=>key==='p_teams'?JSON.stringify(value):key==='p_period_ids'?`{${value.join(',')}}`:value)
   try {
    const result=await db.query(`select ${name}(${entries.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) as result`,parameters)
    return {data:result.rows[0].result,error:null}
   } catch(error) {return {data:null,error}}
  },
 }
}
for(const schema of ['public','sandbox']) {
 await db.exec(`set search_path=${schema},pg_catalog;`)
 const token=await scalar(`select claim_operation('test')`)
 assert.ok(token)
 assert.equal(await scalar(`select claim_operation('test')`),null)
 await db.exec(`update operation_runs set lease_until=now()-interval '1 second' where key='test'`)
 const next=await scalar(`select claim_operation('test')`)
 assert.notEqual(next,token)
 assert.equal(await scalar(`select finish_operation('test',$1,true)`,[token]),false)
 assert.equal(await scalar(`select finish_operation('test',$1,true)`,[next]),true)
 assert.equal(await scalar(`select claim_operation('test')`),null)
 const failed=await scalar(`select claim_operation('failure')`)
 assert.equal(await scalar(`select finish_operation('failure',$1,false,'secret must not be stored')`,[failed]),true)
 assert.equal(await scalar(`select claim_operation('failure')`),null)
 assert.equal(await scalar(`select last_error like '%secret%' from operation_runs where key='failure'`),false)
 await db.exec(`update operation_runs set attempts=7,next_attempt_at=now() where key='failure'`)
 const eighth=await scalar(`select claim_operation('failure')`)
 await db.query(`select finish_operation('failure',$1,false,'Failure')`,[eighth])
 assert.equal(await scalar(`select status from operation_runs where key='failure'`),'review')
 assert.equal(await scalar(`select claim_operation('failure')`),null)
 // A slate may remain pre-lock for hours and need many successful batches.
 // These incomplete successes must never consume its later failure budget.
 for(let pass=0;pass<12;pass++) {
  const waiting=await scalar(`select claim_operation('prelock')`)
  assert.equal(await scalar(`select finish_operation('prelock',$1,false)`,[waiting]),true)
 }
 assert.equal(await scalar(`select attempts from operation_runs where key='prelock'`),0)
 const transient=await scalar(`select claim_operation('prelock')`)
 await db.query(`select finish_operation('prelock',$1,false,'Transient provider failure')`,[transient])
 assert.equal(await scalar(`select status from operation_runs where key='prelock'`),'failed')
 assert.equal(await scalar(`select attempts from operation_runs where key='prelock'`),1)
 assert.equal(await scalar(`select claim_operation('prelock')`),null)
 await db.exec(`update operation_runs set next_attempt_at=now() where key='prelock'`)
 const recovered=await scalar(`select claim_operation('prelock')`)
 await db.query(`select finish_operation('prelock',$1,false)`,[recovered])
 assert.equal(await scalar(`select attempts from operation_runs where key='prelock'`),0)
 console.log(`PASS ${schema}: competing jobs, stale leases, duplicate completion and retry backoff`)
 const slate='00000000-0000-4000-8000-000000000001',player='00000000-0000-4000-8000-000000000002',nextSlate='00000000-0000-4000-8000-000000000003'
 await db.exec(`update pools set competition_mode='regular-season',pick_frequency='every-game-day',auto_pick_behavior='latest-game';
 insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values('${slate}',1,'2026-10-17',2026,true,now()-interval '1 hour'),('${nextSlate}',2,'2026-10-18',2026,false,now()+interval '1 day');
 insert into players(id,full_name,email,pin_hash) values('${player}','O''Brien 🏀','player+test@example.test','test');
 insert into games(slate_id,espn_event_id,home_team,away_team,tip_time,result,status_state) values('${slate}','fixture','A','B',now()-interval '1 hour','pending','pre');`)
 await fails(`insert into picks(player_id,slate_id,team,auto_assigned)values('${player}','${slate}','A',false)`,/locked/)
 const first=await scalar(`select begin_assignment('${slate}')`)
 assert.equal(await scalar(`select begin_assignment('${slate}')`),null)
 await db.exec(`update slates set auto_assign_claimed_at=now()-interval '5 minutes' where id='${slate}'`)
 const second=await scalar(`select begin_assignment('${slate}')`)
 await fails(`select apply_assignment('${slate}','${first}','${player}','[{"team":"A","seed":null}]')`,/lease lost/)
 await db.exec(`select apply_assignment('${slate}','${second}','${player}','[{"team":"A","seed":null}]')`)
 assert.equal(await scalar(`select count(*)::int from picks`),1)
 await fails(`select apply_assignment('${slate}','${second}','${player}','[{"team":"B","seed":null}]')`,/Pick state changed/)
 assert.equal(await scalar(`select finish_assignment('${slate}','${first}',true)`),false)
 assert.equal(await scalar(`select finish_assignment('${slate}','${second}',true)`),true)
 await fails(`select activate_slate_checked('${slate}','${nextSlate}')`,/Results incomplete/)
 await db.exec(`update games set result='away_win',status_state='post' where slate_id='${slate}'`)
 await fails(`select activate_slate_checked('${slate}','${nextSlate}')`,/Grading incomplete/)
 await db.exec(`select grade_pick_loss((select id from picks limit 1),1,'Fixture loss')`)
 await db.exec(`select activate_slate_checked('${slate}','${nextSlate}')`)
 await fails(`select activate_slate_checked('${slate}','${nextSlate}')`,/changed or assignments incomplete/)
 console.log(`PASS ${schema}: stale assignment cannot write; finals, grading and expected active day gate advancement`)
 const firstMissing='00000000-0000-4000-8000-000000000004',secondMissing='00000000-0000-4000-8000-000000000005'
 await db.exec(`update slates set locks_at=now()-interval '1 hour' where id='${nextSlate}';
  insert into games(slate_id,espn_event_id,home_team,away_team,tip_time,result,status_state) values('${nextSlate}','batch-fixture','C','D',now()-interval '1 hour','pending','pre');
  insert into players(id,full_name,email,pin_hash) values('${firstMissing}','First missing','first@example.test','test'),('${secondMissing}','Second missing','second@example.test','test');`)
 const oldAutomation=process.env.AUTOMATION_V2_ENABLED
 process.env.AUTOMATION_V2_ENABLED='true'
 try {
  await assert.rejects(runAutoAssignNow(assignmentClient(firstMissing),new Date()),/Assignment batch failed/)
  assert.equal(await scalar(`select count(*)::int from picks where slate_id='${nextSlate}'`),1,'Successful player writes survive a partial batch failure')
  assert.equal(await scalar(`select status from operation_runs where key='assignment:${nextSlate}'`),'failed')
  assert.equal(await scalar(`select last_error like '%private@example%' from operation_runs where key='assignment:${nextSlate}'`),false)
  assert.equal(await scalar(`select auto_assign_completed_at from slates where id='${nextSlate}'`),null)
  assert.equal(await scalar(`select assignment_token from slates where id='${nextSlate}'`),null,'A failed partial batch releases its assignment lease')
  for(let attempt=2;attempt<=8;attempt++) {
   await db.exec(`update operation_runs set next_attempt_at=now() where key='assignment:${nextSlate}'`)
   await assert.rejects(runAutoAssignNow(assignmentClient(firstMissing),new Date()),/Assignment batch failed/)
   assert.equal(await scalar(`select attempts from operation_runs where key='assignment:${nextSlate}'`),attempt)
  }
  assert.equal(await scalar(`select status from operation_runs where key='assignment:${nextSlate}'`),'review','Persistent player-write failures require organizer review')
  assert.equal((await runAutoAssignNow(assignmentClient(null),new Date())).done,false,'Review state prevents unapproved retries')
  assert.equal(await scalar(`select count(*)::int from picks where slate_id='${nextSlate}'`),1)
  // Match the organizer's reviewed retry after correcting the underlying fault.
  await db.exec(`update operation_runs set status='pending',attempts=0,next_attempt_at=now() where key='assignment:${nextSlate}'`)
  const outcome=await runAutoAssignNow(assignmentClient(null),new Date())
  assert.equal(outcome.done,true)
  assert.equal(await scalar(`select count(*)::int from picks where slate_id='${nextSlate}'`),2,'Retry fills only the missing player without duplicates')
  assert.equal(await scalar(`select status from operation_runs where key='assignment:${nextSlate}'`),'done')
 } finally {
  if(oldAutomation===undefined)delete process.env.AUTOMATION_V2_ENABLED
  else process.env.AUTOMATION_V2_ENABLED=oldAutomation
 }
 console.log(`PASS ${schema}: partial assignment failures back off, preserve accepted picks and recover without duplicates`)
 await db.exec(`insert into notification_outbox(event_key,kind,payload) values('fixture:notice','reminder','{}');`)
 const claimed=(await db.query('select * from claim_notifications(10)')).rows
 assert.ok(claimed.length>=1)
 assert.equal((await db.query('select * from claim_notifications(10)')).rows.length,0)
 const notice=claimed.find(row=>row.event_key==='fixture:notice')
 await db.exec(`update notification_outbox set lease_until=now()-interval '1 second' where id='${notice.id}'`)
 assert.equal(await scalar(`select finish_notification($1,$2,'provider-id')`,[notice.id,notice.lease_token]),false)
 const replacement=(await db.query('select * from claim_notifications(10)')).rows.find(row=>row.id===notice.id)
 assert.notEqual(replacement.lease_token,notice.lease_token)
 assert.equal(await scalar(`select finish_notification($1,$2,'provider-id')`,[notice.id,replacement.lease_token]),true)
 assert.equal(await scalar(`select finish_notification($1,$2,'provider-id')`,[notice.id,replacement.lease_token]),false)
 await db.exec(`insert into notification_outbox(event_key,kind,payload,created_at) values('expired','reminder','{"email":"private@example.test"}',now()-interval '31 days');`)
 await db.exec('select * from claim_notifications(10)')
 assert.equal(await scalar(`select status from notification_outbox where event_key='expired'`),'review')
 const preview=await scalar('select operation_retention(false)')
 assert.equal(preview.notification_payloads,1)
 assert.equal(await scalar(`select payload->>'email' from notification_outbox where event_key='expired'`),'private@example.test')
 await db.exec('select operation_retention(true)')
 assert.deepEqual(await scalar(`select payload from notification_outbox where event_key='expired'`),{})
 assert.equal(await scalar('select count(*)::int from picks'),3)
 await db.exec('set role anon;')
 await fails(`select * from ${schema}.operation_runs`,/permission denied/)
 await fails(`select ${schema}.contest_backup()`,/permission denied/)
 await db.exec('reset role;')
 console.log(`PASS ${schema}: notification claim fencing, stale backlog review, privacy retention and anon denial`)
}
await db.exec('set search_path=public,pg_catalog')
const snapshot=await scalar('select contest_backup()')
const key='fixture-only-encryption-passphrase-123456789'
const envelope=encryptBackup(snapshot,key)
assert.equal(JSON.stringify(envelope).includes('private@example'),false)
assert.deepEqual(decryptBackup(envelope,key),snapshot)
assert.throws(()=>decryptBackup(envelope,key+'wrong'))
const result=await restoreCheck(decryptBackup(envelope,key))
assert.ok(result.rows>0)
console.log(`PASS encrypted backup: authenticated encryption, wrong-key rejection and ${result.tables}-table isolated restore with row digests`)
await db.close()
