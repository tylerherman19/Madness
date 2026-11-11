// Creates a fresh local database `sim` on a local PostgreSQL and applies every
// migration. Refuses any host other than 127.0.0.1/localhost.
import * as pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
const base = process.env.SIM_PG_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:55470/postgres'
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(base)) throw new Error('Local PostgreSQL only')
const admin = new pg.Client({ connectionString: base })
await admin.connect()
for (const role of ['anon', 'authenticated', 'service_role', 'authenticator'])
  await admin.query(`do $$ begin create role ${role}; exception when duplicate_object then null; end $$`)
await admin.query('drop database if exists sim with (force)')
await admin.query('create database sim')
await admin.end()
const db = new pg.Client({ connectionString: base.replace(/\/postgres$/, '/sim') })
await db.connect()
for (const file of (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort())
  await db.query(await readFile(`supabase/migrations/${file}`, 'utf8'))
const n = await db.query("select count(*)::int n from information_schema.tables where table_schema='public'")
console.log('migrated; public tables:', n.rows[0].n)
await db.end()
