// Private copy of the encrypted nightly backup (SEC-01, REL-06).
//
// The repository is public, so its Actions artifacts can be listed and
// downloaded by any signed-in GitHub user. This stores the same encrypted
// archives in a PRIVATE Supabase Storage bucket on the existing project (no new
// service or recurring cost), proves the stored copy is not publicly readable,
// downloads it back, decrypts it and restores it into an isolated in-memory
// database, then prunes old copies.
//
// Limitation (REL-06): the bucket lives in the same Supabase project as the
// data. It protects against bad writes, deletions and a lost GitHub artifact,
// not against losing the project itself.
//
// Never prints backup content, credentials or provider response bodies.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptBackupWithKeys, snapshotDigest } from './backup.mjs'
import { restoreCheck } from './restore-check.mjs'

export const BUCKET = 'madness-backups'
export const RETAIN_DAYS = 30
export const KEEP_AT_LEAST = 7
const SCHEMAS = ['public', 'sandbox']
class PrivateBackupError extends Error {}

const headers = (key, extra = {}) => ({ apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }), ...extra })

export async function ensurePrivateBucket({ url, key }, request = fetch) {
 const read = await request(`${url}/storage/v1/bucket/${BUCKET}`, { headers: headers(key), redirect: 'error', signal: AbortSignal.timeout(30000) })
 let bucket = read.ok ? await read.json() : null
 if (!bucket) {
  const created = await request(`${url}/storage/v1/bucket`, {
   method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
   headers: headers(key, { 'Content-Type': 'application/json' }),
   body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  })
  if (!created.ok) throw new PrivateBackupError(`Could not create the private backup bucket (HTTP ${created.status})`)
  const again = await request(`${url}/storage/v1/bucket/${BUCKET}`, { headers: headers(key), redirect: 'error', signal: AbortSignal.timeout(30000) })
  bucket = again.ok ? await again.json() : null
 }
 // Refuse to write anything into a bucket that is, or became, public.
 if (!bucket || bucket.public !== false) throw new PrivateBackupError('Backup bucket is missing or public; nothing was uploaded')
 return bucket
}

export async function uploadArchive({ url, key }, path, body, request = fetch) {
 const response = await request(`${url}/storage/v1/object/${BUCKET}/${path}`, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
  headers: headers(key, { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }), body,
 })
 if (!response.ok) throw new PrivateBackupError(`Private upload failed (HTTP ${response.status})`)
}

export async function downloadArchive({ url, key }, path, request = fetch) {
 const response = await request(`${url}/storage/v1/object/${BUCKET}/${path}`, { headers: headers(key), redirect: 'error', signal: AbortSignal.timeout(120000) })
 if (!response.ok) throw new PrivateBackupError(`Private download failed (HTTP ${response.status})`)
 return response.text()
}

// Without credentials the stored copy must not be reachable through either
// the public-object path or the plain object path.
export async function assertNotPublic({ url }, path, request = fetch) {
 for (const target of [`${url}/storage/v1/object/public/${BUCKET}/${path}`, `${url}/storage/v1/object/${BUCKET}/${path}`]) {
  const response = await request(target, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (response.ok) throw new PrivateBackupError('A stored backup is readable without credentials')
 }
}

export async function pruneArchives({ url, key }, now = new Date(), request = fetch) {
 const listed = await request(`${url}/storage/v1/object/list/${BUCKET}`, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: headers(key, { 'Content-Type': 'application/json' }),
  body: JSON.stringify({ prefix: 'daily', limit: 1000, sortBy: { column: 'name', order: 'desc' } }),
 })
 if (!listed.ok) throw new PrivateBackupError(`Could not list private backups (HTTP ${listed.status})`)
 // Folders are named by UTC date (YYYY-MM-DD); newest first.
 const days = (await listed.json()).map(item => item?.name).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name ?? '')).sort().reverse()
 const cutoff = new Date(now.getTime() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10)
 const expired = days.slice(KEEP_AT_LEAST).filter(day => day < cutoff)
 if (!expired.length) return []
 const prefixes = []
 for (const day of expired) {
  const inner = await request(`${url}/storage/v1/object/list/${BUCKET}`, {
   method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
   headers: headers(key, { 'Content-Type': 'application/json' }),
   body: JSON.stringify({ prefix: `daily/${day}`, limit: 1000 }),
  })
  if (!inner.ok) throw new PrivateBackupError(`Could not list private backups (HTTP ${inner.status})`)
  for (const run of await inner.json()) {
   const runs = await request(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: `daily/${day}/${run.name}`, limit: 1000 }),
   })
   if (!runs.ok) throw new PrivateBackupError(`Could not list private backups (HTTP ${runs.status})`)
   for (const file of await runs.json()) prefixes.push(`daily/${day}/${run.name}/${file.name}`)
  }
 }
 if (prefixes.length) {
  const removed = await request(`${url}/storage/v1/object/${BUCKET}`, {
   method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30000),
   headers: headers(key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes }),
  })
  if (!removed.ok) throw new PrivateBackupError(`Could not prune private backups (HTTP ${removed.status})`)
 }
 return expired
}

// Upload both archives, prove they are private, read them back, decrypt and
// restore them in isolation, and compare digests with the local files.
export async function storeAndVerify({ url, key, keys, runId, attempt = '1', now = new Date(), files }, { request = fetch, read = readFile, verify = restoreCheck } = {}) {
 if (!url?.startsWith('https://') || !key) throw new PrivateBackupError('Configure the intended Supabase project; credentials are never printed')
 if (!/^[1-9][0-9]{0,19}$/.test(String(runId)) || !/^[1-9][0-9]{0,3}$/.test(String(attempt))) throw new PrivateBackupError('A workflow run id and attempt are required')
 await ensurePrivateBucket({ url, key }, request)
 const day = now.toISOString().slice(0, 10)
 const results = []
 for (const schema of SCHEMAS) {
  const local = await read(files[schema], 'utf8')
  // The attempt keeps a re-run of a failed job from colliding with its first upload.
  const path = `daily/${day}/${runId}-${attempt}/backup-${schema}.json.enc`
  await uploadArchive({ url, key }, path, local, request)
  await assertNotPublic({ url }, path, request)
  const stored = await downloadArchive({ url, key }, path, request)
  let restored
  try {
   const snapshot = decryptBackupWithKeys(JSON.parse(stored), keys)
   const original = decryptBackupWithKeys(JSON.parse(local), keys)
   if (snapshot?.schema !== schema || JSON.stringify(snapshotDigest(snapshot)) !== JSON.stringify(snapshotDigest(original))) throw new Error('mismatch')
   restored = await verify(snapshot)
  } catch { throw new PrivateBackupError(`Stored ${schema} copy could not be decrypted and restored in isolation`) }
  results.push({ schema, path, tables: restored.tables, rows: restored.rows })
 }
 const pruned = await pruneArchives({ url, key }, now, request)
 return { ok: true, bucket: BUCKET, day, schemas: results.map(({ schema, tables, rows }) => ({ schema, tables, rows })), pruned_days: pruned.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const result = await storeAndVerify({
   url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY,
   keys: [process.env.BACKUP_ENCRYPTION_KEY, process.env.BACKUP_ENCRYPTION_KEY_PREVIOUS].filter(Boolean),
   runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
   files: Object.fromEntries(SCHEMAS.map(schema => [schema, `work/backup-${schema}.json.enc`])),
  })
  console.log(JSON.stringify(result))
 } catch (error) {
  console.error(error instanceof PrivateBackupError ? error.message : 'Private backup copy failed')
  process.exitCode = 1
 }
}
