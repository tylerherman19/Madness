// Migration 032 in both schemas: one-time organizer reset links (PGlite, local only).
// PGlite has a single connection, so true concurrency is exercised by the row
// lock design (see the migration) and serially here and in the browser suite.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const db = new PGlite()
await db.exec('create role anon; create role authenticated; create role service_role; create role authenticator;')
for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
await db.exec(await readFile('supabase/migrations/032_password_reset_links.sql', 'utf8')) // idempotent re-run
const value = async (sql, params) => (await db.query(sql, params)).rows[0].value
const sha = text => createHash('sha256').update(text).digest('hex')
const HASH = '$2a$04$' + 'x'.repeat(53)

for (const schema of ['public', 'sandbox']) {
 const player = '00000000-0000-4000-8000-0000000000a1', other = '00000000-0000-4000-8000-0000000000a2'
 await db.exec(`insert into ${schema}.players(id,full_name,email,pin_hash) values('${player}','Reset Player','reset@example.test','old-hash-old-hash-old-hash'),('${other}','Other','other@example.test','other-hash-other-hash-other')`)
 const issue = (token, expires = "now()+interval '60 minutes'") => value(`select ${schema}.issue_password_reset_link($1,$2,${expires},'admin-session') as value`, [player, sha(token)])
 const consume = (token, hash = HASH) => value(`select ${schema}.consume_password_reset_link($1,$2) as value`, [sha(token), hash])

 assert.equal((await issue('first')).status, 'ok')
 assert.equal((await issue('second')).status, 'ok')
 assert.equal((await consume('first')).status, 'invalid', 'a newer link kills the older unused one')
 assert.equal((await consume('second', HASH)).status, 'ok')
 assert.equal((await consume('second', HASH.replace('x', 'y'))).status, 'used', 'exactly one use succeeds')
 assert.equal(await value(`select pin_hash as value from ${schema}.players where id=$1`, [player]), HASH)
 assert.equal(await value(`select pin_hash as value from ${schema}.players where id=$1`, [other]), 'other-hash-other-hash-other', 'other players untouched')
 assert.equal((await issue('third')).status, 'ok')
 await db.exec(`update ${schema}.players set pin_reset_expires=now()-interval '1 second' where id='${player}'`)
 assert.equal((await consume('third')).status, 'expired')
 assert.equal((await consume('never-issued')).status, 'invalid')
 assert.equal((await value(`select ${schema}.issue_password_reset_link('00000000-0000-4000-8000-0000000000ff',$1,now()+interval '1 hour','x') as value`, [sha('nobody')])).status, 'not_found')
 await assert.rejects(issue('too-long', "now()+interval '2 days'"), /Invalid password reset link request/)
 await assert.rejects(value(`select ${schema}.consume_password_reset_link('not-a-hash',$1) as value`, [HASH]), /Invalid password reset request/)

 const audit = (await db.query(`select event_type,actor,player_id,message,details from ${schema}.audit_log where player_id=$1 order by created_at`, [player])).rows
 const events = audit.map(row => row.event_type)
 assert.equal(events.filter(event => event === 'password-reset-link-created').length, 3)
 for (const event of ['password-reset', 'password-reset-link-reused', 'password-reset-link-expired']) assert.ok(events.includes(event), event)
 assert.ok(audit.filter(row => row.event_type === 'password-reset-link-created').every(row => row.actor === 'admin' && row.details.admin_session === 'admin-session'))
 const serialized = JSON.stringify(audit)
 for (const token of ['first', 'second', 'third']) assert.equal(serialized.includes(sha(token)), false, 'no token hash in audit rows')
 assert.equal((await db.query(`select count(*)::int n from ${schema}.audit_log where player_id is null and event_type like 'password-reset%'`)).rows[0].n, 0, 'unknown links are not audited')

 await db.exec('set role anon;')
 await assert.rejects(db.query(`select ${schema}.consume_password_reset_link($1,$2)`, [sha('x'), HASH]), /permission denied/)
 await assert.rejects(db.query(`select ${schema}.issue_password_reset_link($1,$2,now()+interval '1 hour','x')`, [player, sha('x')]), /permission denied/)
 await db.exec('reset role;')
 console.log(`PASS ${schema}: reset links are one-time, superseded by newer links, expire, audit without secrets and deny anon`)
}
await db.close()
