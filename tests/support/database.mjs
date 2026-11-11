// Local-only PostgREST adapter over real PostgreSQL fixtures; never uses production data.
import {createServer} from 'node:http'
import {readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import bcrypt from 'bcryptjs'
const PORT=Number(process.env.E2E_DB_PORT??54329)
// Engine: PGlite by default (one in-process connection, used by every normal test
// suite). FIXTURE_DB_ENGINE=postgres serves the same HTTP surface over a real
// PostgreSQL through a pg Pool (FIXTURE_PG_POOL connections, default 10, like the
// smallest hosted API tier), so concurrent requests really run concurrently.
// The database must already hold the migrations (scripts/sim/init-db.mjs).
// FIXTURE_DB_LATENCY_MS delays each request before it takes a connection, to
// approximate the round trip to a remote database.
const REAL=process.env.FIXTURE_DB_ENGINE==='postgres'
const LATENCY=Number(process.env.FIXTURE_DB_LATENCY_MS??0)
let db,pool
const poolStats={maxWaiting:0,waitSamples:0,waitSum:0,maxBusy:0,queries:0,queryMs:0,acquireMs:0}
if(REAL){
 const pg=await import('pg')
 // PostgREST returns a date column as YYYY-MM-DD, not a JavaScript Date.
 pg.types.setTypeParser(1082,value=>value)
 // Like PostgREST: timestamps keep microseconds (the app round-trips updated_at into save_pick), bigint and numeric are JSON numbers.
 for(const oid of [1184,1114])pg.types.setTypeParser(oid,value=>{const iso=value.replace(' ','T');return /[+-]\d\d$/.test(iso)?iso+':00':/Z|[+-]\d\d:\d\d$/.test(iso)?iso:iso+'+00:00'})
 pg.types.setTypeParser(20,value=>Number(value));pg.types.setTypeParser(1700,value=>Number(value))
 const url=process.env.FIXTURE_PG_URL
 if(!url||!/@(127\.0\.0\.1|localhost)[:/]/.test(url))throw new Error('FIXTURE_PG_URL must point at a local PostgreSQL')
 pool=new pg.Pool({connectionString:url,options:'-c timezone=UTC',max:Number(process.env.FIXTURE_PG_POOL??10),application_name:'fixture-postgrest'})
 pool.on('error',()=>{})
 const timed=async(fn)=>{const t0=performance.now();try{return await fn()}finally{poolStats.queries++;poolStats.queryMs+=performance.now()-t0}}
 db={
  query:(text,params)=>timed(async()=>{const t0=performance.now();const client=await pool.connect();poolStats.acquireMs+=performance.now()-t0;try{return await client.query(text,params)}finally{client.release()}}),
  exec:text=>timed(()=>pool.query(text)),
  // One connection for a statement that needs session settings around it.
  seeded:(text,params)=>timed(async()=>{const client=await pool.connect();try{await client.query('set session_replication_role=replica');try{return await client.query(text,params)}finally{await client.query('set session_replication_role=origin')}}finally{client.release()}}),
 }
 setInterval(()=>{poolStats.waitSamples++;poolStats.waitSum+=pool.waitingCount;poolStats.maxWaiting=Math.max(poolStats.maxWaiting,pool.waitingCount);poolStats.maxBusy=Math.max(poolStats.maxBusy,pool.totalCount-pool.idleCount)},50).unref()
}else{
 const {PGlite}=await import('@electric-sql/pglite')
 // PostgREST returns a date column as YYYY-MM-DD, not a JavaScript Date.
 db=new PGlite({parsers:{1082:value=>value}})
 await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')&&(process.env.FIXTURE_LEGACY_SCHEMA!=='true'||f<'025_')).sort())await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
 db.seeded=async(text,params)=>{await db.exec('set session_replication_role=replica');try{return await db.query(text,params)}finally{await db.exec('set session_replication_role=origin')}}
}
// jsonb parameters must be sent as JSON text; node-postgres would turn a JS
// array into a Postgres array literal. Column and argument types are read once.
const typeCache=new Map()
async function jsonNames(kind,schema,name){
 const key=`${kind}:${schema}.${name}`
 if(!typeCache.has(key)){
  if(!REAL)typeCache.set(key,new Set())
  else if(kind==='table'){const r=await db.query("select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and data_type in ('json','jsonb')",[schema,name]);typeCache.set(key,new Set(r.rows.map(row=>row.column_name)))}
  else{const r=await db.query("select unnest(p.proargnames) as n, unnest(p.proargtypes::oid[]::regtype[]::text[]) as t from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname=$1 and p.proname=$2",[schema,name]).catch(()=>({rows:[]}));typeCache.set(key,new Set(r.rows.filter(row=>/^jsonb?$/.test(row.t)).map(row=>row.n)))}
 }
 return typeCache.get(key)
}
const asJson=(set,key,value)=>REAL&&set.has(key)&&value!==null&&value!==undefined?JSON.stringify(value):value
const hash=await bcrypt.hash('FixturePass123!',4)
async function seed(){
 await db.exec(`set session_replication_role=replica;${process.env.FIXTURE_LEGACY_SCHEMA==='true'?'':`delete from public.notification_attempts;delete from public.provider_events;delete from public.campaign_recipients;delete from public.email_campaigns;delete from public.pick_revisions;delete from public.pick_requests;delete from public.rule_versions;delete from public.integrity_checks;delete from public.incidents;delete from public.operation_runs;`}delete from public.picks;delete from public.players;delete from public.games;delete from public.slates;delete from public.revoked_sessions;delete from public.rate_limits;delete from public.audit_log;delete from public.notification_outbox;set session_replication_role=origin;
 update public.pools set season_year=2099,competition_mode='regular-season',pick_frequency='every-game-day',starts_on=null,auto_pick_behavior='latest-game';
 insert into public.slates(id,slate_number,slate_date,season_year,is_active,locks_at)values('00000000-0000-4000-8000-000000000001',1,'2099-01-01',2099,true,'2099-01-01T18:00:00Z');
 insert into public.games(slate_id,espn_event_id,home_team,away_team,tip_time,result,status_state)values('00000000-0000-4000-8000-000000000001','fixture','A','B','2099-01-01T18:00:00Z','pending','pre');`)
 await db.query(`insert into public.players(id,full_name,email,pin_hash,pin_reset_token,pin_reset_expires)values($1,$2,$3,$4,$5,now()+interval '1 hour'),($6,'Other Player','other@example.test',$4,null,null)`,['00000000-0000-4000-8000-000000000002',"O'Brien 🏀",'player+test@example.test',hash,createHash('sha256').update('a'.repeat(64)).digest('hex'),'00000000-0000-4000-8000-000000000003'])
}
if(process.env.FIXTURE_NO_SEED!=='true')await seed()
const ident=value=>{if(!/^[a-z_]+$/.test(value))throw new Error('Invalid fixture identifier');return '"'+value+'"'}
// Counting mode: every PostgREST-style request the app makes is one database round trip.
let stats={total:0,byTable:{}}
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,`http://127.0.0.1:${PORT}`)
  if(LATENCY>0&&!url.pathname.startsWith('/__test')&&url.pathname!=='/ready')await new Promise(done=>setTimeout(done,LATENCY))
  let raw='';for await(const chunk of req)raw+=chunk
  const body=raw?JSON.parse(raw):{}
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
  if(url.pathname==='/ready')return send(200,{ok:true})
  if(url.pathname==='/__test/stats')return send(200,{...stats,...(REAL?{pool:{size:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount,...poolStats}}:{})})
  if(url.pathname==='/__test/stats/reset'){stats={total:0,byTable:{}};if(REAL)Object.assign(poolStats,{maxWaiting:0,waitSamples:0,waitSum:0,maxBusy:0,queries:0,queryMs:0,acquireMs:0});return send(200,{ok:true})}
  if(url.pathname==='/__test/sql'&&REAL){const r=await db.query(body.sql,body.params??[]);return send(200,{rows:r.rows,rowCount:r.rowCount})}
  if(url.pathname==='/__test/reset'){await seed();return send(200,{ok:true})}
  if(url.pathname==='/__test/lock'){await db.exec("update public.slates set locks_at=now()-interval '1 second' where is_active;update public.games set tip_time=now()-interval '1 second'");return send(200,{ok:true})}
  const parts=url.pathname.split('/').filter(Boolean),table=parts.at(-1)
  stats.total++;{const label=`${req.method} ${parts.includes('rpc')?'rpc:':''}${table}`;stats.byTable[label]=(stats.byTable[label]??0)+1}
  const schema=req.headers['accept-profile']??req.headers['content-profile']??'public'
  const namespace=ident(schema)
  if(parts.includes('rpc')){
   const params=Object.entries(body)
   const query=`select ${namespace}.${ident(table)}(${params.map(([key],i)=>`${ident(key)}=>$${i+1}`).join(',')}) as value`
   const json=await jsonNames('rpc',schema,table)
   const result=await db.query(query,params.map(([key,value])=>asJson(json,key,value)))
   return send(200,result.rows[0]?.value??null)
  }
  const values=[],where=[]
  for(const[key,value]of url.searchParams){
   if(['select','order','limit','offset','on_conflict','columns'].includes(key))continue
   const dot=value.indexOf('.'),op=value.slice(0,dot),val=value.slice(dot+1)
   if(op==='in'){const items=val.slice(1,-1).split(',').filter(Boolean).map(v=>v.replace(/^"|"$/g,''));const list=items.map(v=>{values.push(v);return '$'+values.length});where.push(list.length?`${ident(key)} in (${list.join(',')})`:'false')}
   else if(op==='is')where.push(`${ident(key)} is ${val==='null'?'null':val==='true'?'true':'false'}`)
   else if(op==='not'&&val.startsWith('like.')){values.push(val.slice(5));where.push(`${ident(key)} not like $${values.length}`)}
   else if(op==='not'&&val.startsWith('is.'))where.push(`${ident(key)} is not ${val==='is.null'?'null':val==='is.true'?'true':'false'}`)
   else{const sqlop={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<=',ilike:'ilike'}[op];if(!sqlop)throw new Error('Unsupported fixture filter '+op);values.push(val);where.push(`${ident(key)} ${sqlop} $${values.length}`)}
  }
  const clause=where.length?' where '+where.join(' and '):''
  let query,offset=0
  if(req.method==='POST'){
   const rows=Array.isArray(body)?body:[body],columns=Object.keys(rows[0]),jsonCols=await jsonNames('table',schema,table);
   const conflict=url.searchParams.get('on_conflict')??({email_suppressions:'email',revoked_sessions:'token_hash',teams:'abbr'}[table]??'id')
   const upsert=String(req.headers.prefer??'').includes('resolution=merge-duplicates')?` on conflict (${ident(conflict)}) do update set ${columns.map(column=>`${ident(column)}=excluded.${ident(column)}`).join(',')}`:''
   query=`insert into ${namespace}.${ident(table)}(${columns.map(ident).join(',')}) values ${rows.map(row=>'('+columns.map(column=>{values.push(asJson(jsonCols,column,row[column]));return '$'+values.length}).join(',')+')').join(',')}${upsert} returning *`
  }else if(req.method==='PATCH'){
   const jsonCols=await jsonNames('table',schema,table)
   const assignments=Object.entries(body).map(([key,value])=>{values.push(asJson(jsonCols,key,value));return `${ident(key)}=$${values.length}`})
   query=`update ${namespace}.${ident(table)} set ${assignments.join(',')}${clause} returning *`
  }else if(req.method==='DELETE')query=`delete from ${namespace}.${ident(table)}${clause} returning *`
  else{
   query=`select * from ${namespace}.${ident(table)}${clause}`
   const order=url.searchParams.get('order');if(order)query+=' order by '+order.split(',').map(v=>{const[col,dir]=v.split('.');return ident(col)+(dir==='desc'?' desc':' asc')}).join(',')
   const range=req.headers.range?.split('-').map(Number),limit=range?range[1]-range[0]+1:Number(url.searchParams.get('limit')??1000)
   offset=range?.[0]??Number(url.searchParams.get('offset')??0)
   query+=` limit ${limit} offset ${offset}`
  }
  // Bulk seeding only (scripts/measure-queries.mjs): skip row triggers such as "pick period is not open".
  const seeding=req.headers['x-fixture-seed']==='1'
  const result=seeding?await db.seeded(query,values):await db.query(query,values)
  const rows=result.rows
  if(url.searchParams.get('select')?.includes('players(')&&rows.length){const ids=[...new Set(rows.map(row=>row.player_id))];const embedded=new Map((await db.query(`select * from ${namespace}.players where id=any($1::uuid[])`,[ids])).rows.map(row=>[row.id,row]));for(const row of rows)row.players=embedded.get(row.player_id)??null}
  // Like PostgREST: the total is reported only when a count was requested, and
  // for reads it is the whole filtered table, not the page served.
  const counted=/count=(exact|planned|estimated)/.test(String(req.headers.prefer??''))
  const total=!counted?'*':['GET','HEAD'].includes(req.method)?(await db.query(`select count(*)::int as n from ${namespace}.${ident(table)}${clause}`,values)).rows[0].n:rows.length
  res.setHeader('Content-Range',`${offset}-${offset+Math.max(0,rows.length-1)}/${total}`)
  if(req.method==='HEAD'){res.writeHead(200);return res.end()}
  if(req.headers.accept?.includes('application/vnd.pgrst.object+json')){
   if(rows.length!==1)return send(406,{code:'PGRST116',message:'Expected one row',details:`The result contains ${rows.length} rows`})
   return send(200,rows[0])
  }
  return send(200,rows)
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({code:error.code??'fixture',message:error.message}))}
}).listen(PORT,'127.0.0.1',()=>console.log('Isolated database fixture ready'))
