// Private off-repository storage for encrypted backups: a non-public Supabase
// Storage bucket in the existing Madness project, written with the service
// role. Endpoints follow @supabase/storage-js (bucket info, object upload,
// authenticated download, list, remove). There is deliberately no fallback to
// GitHub artifacts: if the bucket is missing, public or unreachable, the
// command fails and nothing is published anywhere.
//
// Usage (CI): node scripts/backup-storage.mjs preflight
//             node scripts/backup-storage.mjs upload <schema> <file>
//             node scripts/backup-storage.mjs download <schema> <file>
//             node scripts/backup-storage.mjs prune
// Logs contain object names, sizes and HTTP statuses only.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ORIGIN = 'https://ugyimdqnyanmxayhdvje.supabase.co'
export const RETENTION_DAYS = 14
const SCHEMAS = ['public', 'sandbox']
const OBJECT_NAME = /^madness-(public|sandbox)-\d{8}T\d{6}Z-run[1-9][0-9]{0,19}\.json\.enc$/
export class BackupStorageError extends Error {}

export function storageConfig({ supabaseUrl, serviceKey, bucket }) {
 let target
 try { target = new URL(supabaseUrl) } catch { throw new BackupStorageError('Configure SUPABASE_URL for the Madness project') }
 if (target.origin !== PROJECT_ORIGIN || target.pathname !== '/' || target.search || target.hash || target.username || target.password)
  throw new BackupStorageError('Backup storage is restricted to the verified Madness project')
 if (typeof serviceKey !== 'string' || !serviceKey) throw new BackupStorageError('SUPABASE_SERVICE_ROLE_KEY must be configured')
 if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket))
  throw new BackupStorageError('Private backup storage is not configured: set repository variable BACKUP_STORAGE_BUCKET to the private bucket name (see docs/backup-recovery.md). No backup was published.')
 const headers = { apikey: serviceKey, ...(serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${serviceKey}` }) }
 return { base: `${PROJECT_ORIGIN}/storage/v1`, bucket, headers }
}

export function objectName(schema, runId, now = new Date()) {
 if (!SCHEMAS.includes(schema) || typeof runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(runId)) throw new BackupStorageError('A schema and workflow run id are required')
 const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
 return `${schema}/madness-${schema}-${stamp}-run${runId}.json.enc`
}

async function call(request, url, options, failure) {
 let response
 try { response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(60000), ...options }) }
 catch { throw new BackupStorageError(`${failure} (network error)`) }
 // Never read or print an error body: it can echo request details.
 if (!response.ok) throw new BackupStorageError(`${failure} (HTTP ${response.status})`)
 return response
}

// The bucket must exist and must not be public before any archive is written to it.
export async function assertPrivateBucket(config, request = fetch) {
 let response
 try { response = await request(`${config.base}/bucket/${config.bucket}`, { headers: config.headers, redirect: 'error', signal: AbortSignal.timeout(30000) }) }
 catch { throw new BackupStorageError('Backup bucket check failed (network error)') }
 if (!response.ok) throw new BackupStorageError(`Backup bucket "${config.bucket}" is not available to the service role (HTTP ${response.status}); create it as a private bucket. No backup was published.`)
 const bucket = await response.json().catch(() => null)
 if (bucket?.id !== config.bucket && bucket?.name !== config.bucket) throw new BackupStorageError('Backup bucket check returned an unexpected response')
 if (bucket.public !== false) throw new BackupStorageError(`Backup bucket "${config.bucket}" is public; make it private before backups can run. No backup was published.`)
 return true
}

export async function uploadArchive(config, name, bytes, request = fetch) {
 await call(request, `${config.base}/object/${config.bucket}/${name}`, {
  method: 'POST', body: bytes,
  headers: { ...config.headers, 'Content-Type': 'application/octet-stream', 'cache-control': 'no-store', 'x-upsert': 'false' },
 }, 'Encrypted backup upload failed')
 return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export async function downloadArchive(config, name, request = fetch) {
 const response = await call(request, `${config.base}/object/${config.bucket}/${name}`, { headers: config.headers }, 'Encrypted backup download failed')
 return Buffer.from(await response.arrayBuffer())
}

// Deletes only this workflow's archive names older than the retention window.
export async function pruneArchives(config, { now = new Date(), keep = [] } = {}, request = fetch) {
 const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000
 const doomed = []
 for (const schema of SCHEMAS) {
  for (let offset = 0; ; offset += 100) {
   const response = await call(request, `${config.base}/object/list/${config.bucket}`, {
    method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: schema, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
   }, 'Backup listing failed')
   const items = await response.json().catch(() => null)
   if (!Array.isArray(items)) throw new BackupStorageError('Backup listing returned an unexpected response')
   for (const item of items) {
    const path = `${schema}/${item?.name}`
    // Age comes from the timestamp this workflow wrote into the name, not from listing metadata.
    const stamp = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-run/.exec(String(item?.name))
    const created = stamp ? Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`) : NaN
    if (OBJECT_NAME.test(String(item?.name)) && item.name.startsWith(`madness-${schema}-`) && Number.isFinite(created) && created < cutoff && !keep.includes(path)) doomed.push(path)
   }
   if (items.length < 100) break
  }
 }
 if (doomed.length) await call(request, `${config.base}/object/${config.bucket}`, {
  method: 'DELETE', headers: { ...config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: doomed }),
 }, 'Backup pruning failed')
 return doomed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const [command, schema, file] = process.argv.slice(2)
 const manifest = 'work/backup-storage.json'
 try {
  const config = storageConfig({ supabaseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, bucket: process.env.BACKUP_STORAGE_BUCKET })
  if (command === 'preflight') {
   await assertPrivateBucket(config)
   console.log(`Private backup bucket "${config.bucket}" is reachable and not public.`)
  } else if (command === 'upload') {
   await assertPrivateBucket(config)
   const name = objectName(schema, process.env.GITHUB_RUN_ID)
   const stored = await uploadArchive(config, name, await readFile(file))
   const entries = JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'))
   await writeFile(manifest, JSON.stringify({ ...entries, [schema]: stored }))
   console.log(`Stored ${stored.name} (${stored.bytes} bytes) in private bucket "${config.bucket}".`)
  } else if (command === 'download') {
   const stored = JSON.parse(await readFile(manifest, 'utf8'))[schema]
   if (!stored?.name) throw new BackupStorageError(`No stored ${schema} archive was recorded in this run`)
   const bytes = await downloadArchive(config, stored.name)
   if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256) throw new BackupStorageError('Downloaded archive differs from the uploaded archive')
   await writeFile(file, bytes, { mode: 0o600 })
   console.log(`Downloaded ${stored.name} from private storage; digest matches the upload.`)
  } else if (command === 'prune') {
   const keep = Object.values(JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'))).map(entry => entry.name)
   const removed = await pruneArchives(config, { keep })
   console.log(`Removed ${removed.length} archive(s) older than ${RETENTION_DAYS} days.`)
  } else throw new BackupStorageError('Unknown command')
 } catch (error) {
  console.error(error instanceof BackupStorageError ? error.message : 'Backup storage step failed')
  process.exitCode = 1
 }
}
