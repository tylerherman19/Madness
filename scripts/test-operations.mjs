import {PGlite} from '@electric-sql/pglite'
import {readFile,readdir} from 'node:fs/promises'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {randomUUID} from 'node:crypto'
import {encryptBackup,decryptBackup,fetchBackupSnapshot} from './backup.mjs'
import {restoreCheck} from './restore-check.mjs'
import {configureScheduler} from './configure-scheduler.mjs'
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
// Only the fixed project and reviewed bootstrap response can be accepted.
const schedulerConfig={supabaseUrl:'https://ugyimdqnyanmxayhdvje.supabase.co',serviceKey:'fixture-service-role',cronSecret:'fixture-existing-cron-authorization'}
const schedulerJobs=['madness-independent-workers','madness-schedule-sync','madness-retention']
const schedulerCalls=[]
const schedulerRequest=async(url,options)=>{
 schedulerCalls.push({url,options})
 return {ok:true,json:async()=>({ok:true,enabled:JSON.parse(options.body).p_enable,configured:3,base_url:'https://madness-cyan.vercel.app',job_names:schedulerJobs,unexpected_secret:schedulerConfig.cronSecret})}
}
for(const enable of [false,true]) {
 const summary=await configureScheduler({...schedulerConfig,enable},schedulerRequest)
 assert.equal(summary.enabled,enable)
 assert.equal(JSON.stringify(summary).includes(schedulerConfig.cronSecret),false,'Output only contains reviewed non-secret fields')
}
assert.ok(schedulerCalls.every(({url,options})=>url==='https://ugyimdqnyanmxayhdvje.supabase.co/rest/v1/rpc/bootstrap_madness_scheduler' && options.headers['Content-Profile']==='public' && options.redirect==='error'))
assert.deepEqual(schedulerCalls.map(({options})=>JSON.parse(options.body)),[false,true].map(enable=>({p_cron_secret:schedulerConfig.cronSecret,p_enable:enable})))
const schedulerCallCount=schedulerCalls.length
for(const supabaseUrl of ['https://other.supabase.co','https://ugyimdqnyanmxayhdvje.supabase.co.evil.test','https://ugyimdqnyanmxayhdvje.supabase.co/other','https://user@ugyimdqnyanmxayhdvje.supabase.co','https://ugyimdqnyanmxayhdvje.supabase.co/?target=elsewhere']) {
 await assert.rejects(configureScheduler({...schedulerConfig,supabaseUrl},schedulerRequest),/restricted to the verified Madness project/)
}
await assert.rejects(configureScheduler({...schedulerConfig,enable:'true'},schedulerRequest),/must be a boolean/)
assert.equal(schedulerCalls.length,schedulerCallCount,'Wrong target and invalid configuration must not send credentials')
let errorBodyRead=false
await assert.rejects(configureScheduler(schedulerConfig,async()=>({ok:false,status:503,json:async()=>{errorBodyRead=true;return {secret:schedulerConfig.cronSecret}}})),/^Error: Scheduler configuration failed \(HTTP 503\)$/)
assert.equal(errorBodyRead,false,'Provider/database error bodies must not be read or logged')
await assert.rejects(configureScheduler(schedulerConfig,async()=>{throw new Error(schedulerConfig.cronSecret)}),/^Error: Scheduler configuration request failed$/)
await assert.rejects(configureScheduler(schedulerConfig,async()=>({ok:true,json:async()=>({ok:true,enabled:false,configured:3,base_url:'https://other.example',job_names:schedulerJobs})})),/could not be verified/)
console.log('PASS scheduler client: fixed target, explicit activation, sanitized output and safe failure handling')
const db=new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql') && f < '025_').sort()) await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
await db.exec(await readFile('supabase/migrations/024_operations.sql','utf8'))
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0]
const fails=async(sql,pattern)=>assert.rejects(db.exec(sql),pattern)
// The temporary RPC compiles with a fixed search path and cannot be invoked
// by a public caller. Real extension execution remains a hosted setup check.
await db.exec(await readFile('docs/reliability/bootstrap-scheduler.sql','utf8'))
const bootstrapSignature='public.bootstrap_madness_scheduler(text,boolean)'
assert.equal(await scalar(`select has_function_privilege('anon',$1,'EXECUTE')`,[bootstrapSignature]),false)
assert.equal(await scalar(`select has_function_privilege('authenticated',$1,'EXECUTE')`,[bootstrapSignature]),false)
assert.equal(await scalar(`select has_function_privilege('service_role',$1,'EXECUTE')`,[bootstrapSignature]),true)
assert.equal(await scalar(`select prosecdef from pg_proc where oid=$1::regprocedure`,[bootstrapSignature]),true)
assert.deepEqual(await scalar(`select proconfig from pg_proc where oid=$1::regprocedure`,[bootstrapSignature]),['search_path=pg_catalog'])
await db.exec('set role anon')
await fails(`select public.bootstrap_madness_scheduler('fixture-cron-authorization',false)`,/permission denied/)
await db.exec('reset role; drop function public.bootstrap_madness_scheduler(text,boolean);')
console.log('PASS scheduler RPC boundary: fixed definer search path, service-role-only execution and anon denial')

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
 'server-only':{},'node:crypto':{randomUUID},'./revalidateContest':{revalidateContest(){}},'./deadline':deadline,
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

// D-4: tournament auto-pick order with every migration applied. Ranking ties
// are never broken by guess: no snapshot means affected entries wait, the
// organizer sees an incident, and the run retries once rankings exist.
{
 const pg=new PGlite()
 await pg.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
 await pg.exec('set search_path=public,pg_catalog')
 const one=async(sql,params=[])=>Object.values((await pg.query(sql,params)).rows[0])[0]
 const tableRows=async table=>(await pg.query(`select to_jsonb(r) as data from ${table} r`)).rows.map(row=>row.data)
 let liveRanks={}, rankReads=0
 const failures=[]
 const {runAutoAssignNow:assign}=await loadTs('src/lib/autoAssign.ts',{
  'server-only':{},'node:crypto':{randomUUID},'./revalidateContest':{revalidateContest(){}},'./deadline':deadline,
  './pool':{getPoolConfig:async()=>(await tableRows('pools')).find(row=>row.is_active)},
  './competition':competition,'./espn':{fetchApRankings:async()=>{rankReads++;return liveRanks}},'./operations':operations,
  './audit':{logAudit:async()=>{}},'./alerts':{reportFailure:async(_db,report)=>{failures.push(report)}},
  './db':{selectAllIn:async()=>tableRows('picks')},
  './seasonData':{
   loadAll:async(_client,table)=>tableRows(table),
   loadGamesForSlates:async(_client,ids)=>(await tableRows('games')).filter(row=>ids.includes(row.slate_id)),
   loadPicksForSlates:async(_client,ids)=>(await tableRows('picks')).filter(row=>ids.includes(row.slate_id)),
  },
 })
 // A small PostgREST stand-in over PGlite: select/eq/is/update/single and rpc.
 // `beforeApply` lets a test act between the worker's read and its write.
 function client(beforeApply) {
  return {
   from(table) {
    const where=[],params=[];let patch=null,inserted=null
    const run=async()=>{
     const clause=where.length?` where ${where.join(' and ')}`:''
     if(inserted){
      try {
       const saved=[]
       for(const row of [inserted].flat()){
        const keys=Object.keys(row)
        saved.push((await pg.query(`insert into ${table}(${keys.join(',')}) values(${keys.map((_,index)=>`$${index+1}`).join(',')}) returning to_jsonb(${table}) as data`,keys.map(key=>row[key]))).rows[0].data)
       }
       return {data:saved,error:null}
      } catch(error) {return {data:null,error}}
     }
     if(patch){
      const keys=Object.keys(patch)
      const sets=keys.map((key,index)=>`${key}=$${params.length+index+1}`)
      const values=keys.map(key=>typeof patch[key]==='object'&&patch[key]!==null?JSON.stringify(patch[key]):patch[key])
      return {data:(await pg.query(`update ${table} set ${sets.join(',')}${clause} returning to_jsonb(${table}) as data`,[...params,...values])).rows.map(row=>row.data),error:null}
     }
     return {data:(await pg.query(`select to_jsonb(r) as data from ${table} r${clause}`,params)).rows.map(row=>row.data),error:null}
    }
    const query={
     select(){return query},
     eq(key,value){params.push(value);where.push(`${key}=$${params.length}`);return query},
     is(key,value){if(value!==null)throw new Error('fixture supports is(null) only');where.push(`${key} is null`);return query},
     update(value){patch=value;return query},
     insert(value){inserted=value;return query},
     async maybeSingle(){const result=await run();return {...result,data:result.data[0]??null}},
     async single(){return query.maybeSingle()},
     then(resolve,reject){return run().then(resolve,reject)},
    }
    return query
   },
   async rpc(name,args) {
    if(name==='apply_assignment'&&beforeApply)await beforeApply(args)
    const entries=Object.entries(args)
    const values=entries.map(([key,value])=>key==='p_teams'?JSON.stringify(value):key==='p_period_ids'?`{${value.join(',')}}`:value)
    try {
     const result=await pg.query(`select ${name}(${entries.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) as result`,values)
     return {data:result.rows[0].result,error:null}
    } catch(error) {return {data:null,error}}
   },
  }
 }
 const slate='00000000-0000-4000-8000-0000000000d1'
 const entries=['00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-0000000000e3']
 async function resetBracket() {
  await pg.exec(`set session_replication_role=replica;delete from picks;delete from players;delete from games;delete from slates;delete from incidents;delete from operation_runs;set session_replication_role=origin;
   update pools set season_year=2099,competition_mode='march-madness',pick_frequency='every-game-day',auto_pick_behavior='highest-seed',starts_on=null;
   insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values('${slate}',1,'2099-03-19',2099,true,now()-interval '1 hour');
   insert into players(id,full_name,email,pin_hash) values('${entries[0]}','Entry One','one@example.test','x'),('${entries[1]}','Entry Two','two@example.test','x'),('${entries[2]}','Entry Three','three@example.test','x');
   insert into games(slate_id,espn_event_id,home_team,away_team,home_seed,away_seed,tip_time,round_label,result,status_state) values
    ('${slate}','g1','ALPHA','SIXTEEN_A',1,16,now()-interval '1 hour','1st Round','pending','pre'),
    ('${slate}','g2','ZETA','SIXTEEN_Z',1,16,now()-interval '2 hours','1st Round','pending','pre');`)
  assert.equal(await one(`select jsonb_array_length(assignment_schedule) from slates where id='${slate}'`),2,'The frozen lock-time schedule exists')
  assert.equal(await one(`select assignment_rankings from slates where id='${slate}'`),null)
 }
 const picksFor=async player=>(await pg.query(`select team,auto_assigned,submitted_by_admin from picks where player_id=$1 order by team`,[player])).rows
 const env={v2:process.env.AUTOMATION_V2_ENABLED,reliable:process.env.TOURNAMENT_RELIABILITY_ENABLED}
 try {
  process.env.AUTOMATION_V2_ENABLED='true';process.env.TOURNAMENT_RELIABILITY_ENABLED='true'
  // Two 1-seeds and no ranking snapshot: nobody is assigned by name order.
  await resetBracket();liveRanks={}
  const waiting=await assign(client(),new Date())
  assert.equal(waiting.ok,true);assert.equal(waiting.done,false)
  assert.equal(await one('select count(*)::int from picks'),0,'Missing rankings never fall back to alphabetical order')
  assert.equal(await one(`select status from incidents where key='assignment-rankings:${slate}'`),'open','The organizer sees why assignment is waiting')
  assert.equal(await one(`select status from operation_runs where key='assignment:${slate}'`),'pending','Waiting is a clean retry, not a failure toward review')
  assert.equal(await one(`select attempts from operation_runs where key='assignment:${slate}'`),0)
  assert.equal(await one(`select auto_assign_completed_at from slates where id='${slate}'`),null)
  // Rankings load: the first good read is saved once and used for everyone.
  liveRanks={ZETA:3,ALPHA:9}
  const filled=await assign(client(),new Date())
  assert.equal(filled.done,true)
  assert.deepEqual(await one(`select assignment_rankings from slates where id='${slate}'`),{ZETA:3,ALPHA:9},'The snapshot is saved after lock when none existed')
  for(const player of entries) assert.deepEqual(await picksFor(player),[{team:'ZETA',auto_assigned:true,submitted_by_admin:false}],'Seed line tie broken by AP rank, not name')
  console.log('PASS D-4 durable: missing rankings wait with an incident and no failure budget, then a saved snapshot assigns by rank')

  // A saved snapshot wins over a later, different feed read.
  await resetBracket();await pg.exec(`update slates set assignment_rankings='{"ALPHA":2,"ZETA":7}' where id='${slate}'`)
  liveRanks={ZETA:1};rankReads=0
  assert.equal((await assign(client(),new Date())).done,true)
  assert.equal(rankReads,0,'A saved snapshot is used without reading the feed')
  assert.deepEqual((await picksFor(entries[0])).map(pick=>pick.team),['ALPHA'])
  console.log('PASS D-4 durable: the saved pre-lock snapshot is authoritative')

  // A snapshot that ranks neither team: the existing name order decides
  // (owner decision pending), and the organizer is told it happened.
  await resetBracket();await pg.exec(`update slates set assignment_rankings='{"OTHER":1}' where id='${slate}'`)
  assert.equal((await assign(client(),new Date())).done,true)
  assert.deepEqual((await picksFor(entries[0])).map(pick=>pick.team),['ALPHA'])
  assert.equal(await one(`select status from incidents where key='assignment-name-order:${slate}'`),'open','A name-order tiebreak is never silent')
  console.log('PASS D-4 durable: an unranked same-seed tie keeps name order but raises an incident')

  // Simultaneous workers: exactly one claims, nobody gets two picks.
  await resetBracket();liveRanks={ZETA:3,ALPHA:9}
  const racing=await Promise.allSettled([assign(client(),new Date()),assign(client(),new Date()),assign(client(),new Date())])
  assert.ok(racing.every(outcome=>outcome.status==='fulfilled'),'Losing workers back off without error')
  assert.equal(await one('select count(*)::int from picks'),3)
  assert.equal(await one('select count(distinct player_id)::int from picks'),3,'One assignment per entry under concurrent runs')
  console.log('PASS D-4 durable: concurrent runs assign each entry once')

  // An organizer's manual pick lands between the worker's read and its write.
  await resetBracket();liveRanks={ZETA:3,ALPHA:9}
  let raced=false
  const manualFirst=client(async args=>{
   if(raced||args.p_player_id!==entries[1])return
   raced=true
   await pg.query(`insert into picks(player_id,slate_id,team,auto_assigned,submitted_by_admin) values($1,$2,'ALPHA',false,true)`,[entries[1],slate])
  })
  await assert.rejects(assign(manualFirst,new Date()),/Assignment batch failed/)
  assert.deepEqual(await picksFor(entries[1]),[{team:'ALPHA',auto_assigned:false,submitted_by_admin:true}],'The database rejects the stale automatic write; the manual pick stands')
  assert.equal(await one(`select count(*)::int from picks where player_id=$1`,[entries[0]]),1,'Other entries in the batch are kept')
  await pg.exec(`update operation_runs set next_attempt_at=now() where key='assignment:${slate}'`)
  assert.equal((await assign(client(),new Date())).done,true,'The retry completes without touching the manual pick')
  assert.deepEqual(await picksFor(entries[1]),[{team:'ALPHA',auto_assigned:false,submitted_by_admin:true}])
  assert.equal(await one('select count(*)::int from picks'),3)
  await assert.rejects(pg.query(`insert into picks(player_id,slate_id,team,auto_assigned,submitted_by_admin) values($1,$2,'ZETA',true,false)`,[entries[1],slate]),/quota|already/i,'Database constraints still stop a second pick for the period')
  console.log('PASS D-4 durable: a manual pick racing an automatic one wins; retry and constraints prevent duplicates')

  // Legacy path (flags off): the same wait, recorded in the failure trail.
  process.env.AUTOMATION_V2_ENABLED='false';process.env.TOURNAMENT_RELIABILITY_ENABLED='false'
  await resetBracket();liveRanks={};failures.length=0
  const legacy=await assign(client(),new Date())
  assert.equal(legacy.done,false);assert.equal(await one('select count(*)::int from picks'),0)
  assert.ok(failures.some(report=>report.key===`assignment-rankings:${slate}`),'Legacy runs report the wait to the organizer')
  // A single team on the best line needs no ranking at all.
  await pg.exec(`update slates set auto_assign_claimed_at=null where id='${slate}';update games set home_seed=2 where espn_event_id='g2';update slates set assignment_schedule=null where id='${slate}';update games set tip_time=tip_time where slate_id='${slate}'`)
  const unique=await assign(client(),new Date())
  assert.equal(unique.done,true)
  assert.deepEqual((await picksFor(entries[2])).map(pick=>pick.team),['ALPHA'],'An untied best seed is assigned without rankings')
  console.log('PASS D-4 legacy: missing rankings wait and report; an untied seed line still assigns')
 } finally {
  for(const [name,value] of [['AUTOMATION_V2_ENABLED',env.v2],['TOURNAMENT_RELIABILITY_ENABLED',env.reliable]]) {
   if(value===undefined)delete process.env[name];else process.env[name]=value
  }
  await pg.close()
 }
}
