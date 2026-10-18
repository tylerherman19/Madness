// Restore only into a new in-memory database. There is deliberately no production target argument.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { decryptBackup, snapshotDigest } from './backup.mjs'
export async function restoreCheck(snapshot) {
 const db = new PGlite()
 try {
  await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
  for (const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
  const allowed = ['teams','pools','slates','players','games','picks','audit_log','notification_outbox','contest_archives','revoked_sessions','operation_runs','email_suppressions']
  const optional=['rate_limits','clock','player_accounts','notification_preferences','push_devices']
  if (![1,2].includes(snapshot.version) || !snapshot.tables || allowed.some(table=>!Array.isArray(snapshot.tables[table])) || Object.keys(snapshot.tables).some(table=>!allowed.includes(table)&&!optional.includes(table))) throw new Error('Incomplete or unsupported backup')
  for(const table of optional.filter(table=>table in snapshot.tables)) {
   const exists=(await db.query('select to_regclass($1) as relation',[`public.${table}`])).rows[0].relation
   if(!exists) {
    const columns=snapshot.columns?.[table]
    const types=new Set(['uuid','text','boolean','integer','bigint','timestamp with time zone','timestamp without time zone','jsonb','date','inet'])
    if(!Array.isArray(columns)||!columns.length||columns.some(column=>!/^[_a-z][_a-z0-9]*$/.test(column.name)||!types.has(column.type)))throw new Error(`Missing/unsupported schema for ${table}; restore with its matching source revision`)
    await db.exec(`create table public.${table} (${columns.map(column=>'"'+column.name+'" '+column.type).join(',')})`)
   }
   allowed.push(table)
  }
  await db.exec('begin; set session_replication_role=replica;')
  // Empty seeded fixture data in this isolated instance, never a live database.
  for (const table of [...allowed].reverse()) await db.exec(`delete from public.${table}`)
  for (const table of allowed) {
   if (!snapshot.tables[table].length) continue
   let columns = (await db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position',['public',table])).rows.map(row=>row.column_name)
   const backedColumns=Object.keys(snapshot.tables[table][0])
   for(const name of backedColumns.filter(name=>!columns.includes(name))) {
    const definition=snapshot.columns?.[table]?.find(column=>column.name===name)
    const types=new Set(['uuid','text','boolean','integer','bigint','timestamp with time zone','timestamp without time zone','jsonb','date','inet','uuid[]','text[]'])
    if(!/^[_a-z][_a-z0-9]*$/.test(name)||!definition||!types.has(definition.type))throw new Error(`Missing/unsupported extra column in ${table}; use its matching source revision`)
    // Preserve additional deployed fields in this isolated data-recovery fixture.
    // Production schema/policies still require their authoritative migrations.
    await db.exec(`alter table public.${table} add column "${name}" ${definition.type}`)
    columns.push(name)
   }
   const names=backedColumns.map(name=>'"'+name+'"').join(',')
   await db.query(`insert into public.${table} (${names}) select ${names} from jsonb_populate_recordset(null::public.${table},$1::jsonb)`,[JSON.stringify(snapshot.tables[table])])
  }
  const restored={tables:{}}
  for (const table of allowed) restored.tables[table]=(await db.query(`select * from public.${table}`)).rows
  // PGlite serializes timestamps canonically; compare via PostgreSQL jsonb on both sides.
  for (const table of allowed) {
   const normalized=(await db.query(`select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) as rows from jsonb_populate_recordset(null::public.${table},$1::jsonb) r`,[JSON.stringify(snapshot.tables[table])])).rows[0].rows
   const actual=(await db.query(`select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) as rows from public.${table} r`)).rows[0].rows
   const backedColumns=Object.keys(snapshot.tables[table][0]??{})
   const project=rows=>rows.map(row=>Object.fromEntries(backedColumns.map(name=>[name,row[name]])))
   assert.deepEqual(snapshotDigest({tables:{[table]:project(actual)}}),snapshotDigest({tables:{[table]:project(normalized)}}),`${table} restore mismatch`)
  }
  const orphans=(await db.query(`select count(*)::int as n from public.picks p left join public.players r on r.id=p.player_id left join public.slates s on s.id=p.slate_id where r.id is null or s.id is null`)).rows[0].n
  assert.equal(orphans,0,'Restored picks must retain their entries and slates')
  assert.equal((await db.query(`select count(*)::int as n from public.games g left join public.slates s on s.id=g.slate_id where s.id is null`)).rows[0].n,0,'Restored games must retain their slates')
  await db.exec('rollback;')
  return { tables: allowed.length, rows: Object.values(snapshot.tables).reduce((n,rows)=>n+rows.length,0) }
 } finally { await db.close() }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const envelope=JSON.parse(await readFile(process.argv[2],'utf8'))
  const snapshot=decryptBackup(envelope,process.env.BACKUP_ENCRYPTION_KEY)
  const result=await restoreCheck(snapshot)
  console.log(`PASS isolated restore: ${result.tables} tables, ${result.rows} rows reconciled. No live database was modified.`)
 } catch (error) {
  // SQL errors can include complete rows/parameters. Never put backup data in CI logs.
  console.error('Isolated restore verification failed. Check the backup key and matching schema revision.', error.code ?? error.name)
  process.exitCode=1
 }
}
