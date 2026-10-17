// Local-only PostgREST adapter over real PostgreSQL fixtures; never uses production data.
import {createServer} from 'node:http'
import {PGlite} from '@electric-sql/pglite'
import {readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import bcrypt from 'bcryptjs'
const db=new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
const hash=await bcrypt.hash('FixturePass123!',4)
async function seed(){
 await db.exec(`set session_replication_role=replica;delete from public.picks;delete from public.players;delete from public.games;delete from public.slates;delete from public.revoked_sessions;delete from public.audit_log;delete from public.notification_outbox;set session_replication_role=origin;
 update public.pools set competition_mode='regular-season',pick_frequency='every-game-day',starts_on=null,auto_pick_behavior='latest-game';
 insert into public.slates(id,slate_number,slate_date,season_year,is_active,locks_at)values('00000000-0000-4000-8000-000000000001',1,'2099-01-01',2099,true,'2099-01-01T18:00:00Z');
 insert into public.games(slate_id,espn_event_id,home_team,away_team,tip_time,result,status_state)values('00000000-0000-4000-8000-000000000001','fixture','A','B','2099-01-01T18:00:00Z','pending','pre');`)
 await db.query(`insert into public.players(id,full_name,email,pin_hash,pin_reset_token,pin_reset_expires)values($1,$2,$3,$4,$5,now()+interval '1 hour'),($6,'Other Player','other@example.test',$4,null,null)`,['00000000-0000-4000-8000-000000000002',"O'Brien 🏀",'player+test@example.test',hash,createHash('sha256').update('a'.repeat(64)).digest('hex'),'00000000-0000-4000-8000-000000000003'])
}
await seed()
const ident=value=>{if(!/^[a-z_]+$/.test(value))throw new Error('Invalid fixture identifier');return '"'+value+'"'}
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:54329')
  let raw='';for await(const chunk of req)raw+=chunk
  const body=raw?JSON.parse(raw):{}
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
  if(url.pathname==='/ready')return send(200,{ok:true})
  if(url.pathname==='/__test/reset'){await seed();return send(200,{ok:true})}
  if(url.pathname==='/__test/lock'){await db.exec("update public.slates set locks_at=now()-interval '1 second' where is_active;update public.games set tip_time=now()-interval '1 second'");return send(200,{ok:true})}
  const parts=url.pathname.split('/').filter(Boolean),table=parts.at(-1)
  const schema=req.headers['accept-profile']??req.headers['content-profile']??'public'
  const namespace=ident(schema)
  if(parts.includes('rpc')){
   const params=Object.entries(body)
   const query=`select ${namespace}.${ident(table)}(${params.map(([key],i)=>`${ident(key)}=>$${i+1}`).join(',')}) as value`
   const result=await db.query(query,params.map(([,value])=>value))
   return send(200,result.rows[0]?.value??null)
  }
  const values=[],where=[]
  for(const[key,value]of url.searchParams){
   if(['select','order','limit','offset','on_conflict'].includes(key))continue
   const dot=value.indexOf('.'),op=value.slice(0,dot),val=value.slice(dot+1)
   if(op==='in'){const items=val.slice(1,-1).split(',').filter(Boolean).map(v=>v.replace(/^"|"$/g,''));const list=items.map(v=>{values.push(v);return '$'+values.length});where.push(list.length?`${ident(key)} in (${list.join(',')})`:'false')}
   else if(op==='is')where.push(`${ident(key)} is ${val==='null'?'null':val==='true'?'true':'false'}`)
   else{const sqlop={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<=',ilike:'ilike'}[op];if(!sqlop)throw new Error('Unsupported fixture filter '+op);values.push(val);where.push(`${ident(key)} ${sqlop} $${values.length}`)}
  }
  const clause=where.length?' where '+where.join(' and '):''
  let query
  if(req.method==='POST'){
   const rows=Array.isArray(body)?body:[body],columns=Object.keys(rows[0]);
   const conflict=url.searchParams.get('on_conflict')??({email_suppressions:'email',revoked_sessions:'token_hash',teams:'abbr'}[table]??'id')
   const upsert=String(req.headers.prefer??'').includes('resolution=merge-duplicates')?` on conflict (${ident(conflict)}) do update set ${columns.map(column=>`${ident(column)}=excluded.${ident(column)}`).join(',')}`:''
   query=`insert into ${namespace}.${ident(table)}(${columns.map(ident).join(',')}) values ${rows.map(row=>'('+columns.map(column=>{values.push(row[column]);return '$'+values.length}).join(',')+')').join(',')}${upsert} returning *`
  }else if(req.method==='PATCH'){
   const assignments=Object.entries(body).map(([key,value])=>{values.push(value);return `${ident(key)}=$${values.length}`})
   query=`update ${namespace}.${ident(table)} set ${assignments.join(',')}${clause} returning *`
  }else if(req.method==='DELETE')query=`delete from ${namespace}.${ident(table)}${clause} returning *`
  else{
   query=`select * from ${namespace}.${ident(table)}${clause}`
   const order=url.searchParams.get('order');if(order)query+=' order by '+order.split(',').map(v=>{const[col,dir]=v.split('.');return ident(col)+(dir==='desc'?' desc':' asc')}).join(',')
   const range=req.headers.range?.split('-').map(Number),offset=range?.[0]??Number(url.searchParams.get('offset')??0),limit=range?range[1]-range[0]+1:Number(url.searchParams.get('limit')??1000)
   query+=` limit ${limit} offset ${offset}`
  }
  const result=await db.query(query,values),rows=result.rows
  if(url.searchParams.get('select')?.includes('players('))for(const row of rows)row.players=(await db.query(`select * from ${namespace}.players where id=$1`,[row.player_id])).rows[0]??null
  res.setHeader('Content-Range',`0-${Math.max(0,rows.length-1)}/${rows.length}`)
  if(req.method==='HEAD'){res.writeHead(200);return res.end()}
  if(req.headers.accept?.includes('application/vnd.pgrst.object+json')){
   if(rows.length!==1)return send(406,{code:'PGRST116',message:'Expected one row',details:`The result contains ${rows.length} rows`})
   return send(200,rows[0])
  }
  return send(200,rows)
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({code:error.code??'fixture',message:error.message}))}
}).listen(54329,'127.0.0.1',()=>console.log('Isolated database fixture ready'))
