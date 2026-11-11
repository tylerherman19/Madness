// Run only after the encrypted artifact upload has succeeded. No backup rows,
// credentials, response bodies or provider errors belong in workflow logs.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptBackup } from './backup.mjs'
import { restoreCheck } from './restore-check.mjs'

const PROJECT_ORIGIN = 'https://ugyimdqnyanmxayhdvje.supabase.co'
const REPOSITORY = 'tylerherman19/Madness'
const SCHEMAS = ['public', 'sandbox']
const KEY = 'recovery:backup-restore'
class BackupCheckError extends Error {}
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const validId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)

export async function recordBackupChecks({ supabaseUrl, serviceKey, encryptionKey, githubRepository, githubRunId, commitSha, artifactId, archives }, {
 read = readFile, decrypt = decryptBackup, verify = restoreCheck, request = fetch, now = () => new Date(),
} = {}) {
 let target
 try { target = new URL(supabaseUrl) } catch { throw new BackupCheckError('Configure the verified Madness Supabase project') }
 if (target.origin !== PROJECT_ORIGIN || target.pathname !== '/' || target.search || target.hash || target.username || target.password)
  throw new BackupCheckError('Backup telemetry is restricted to the verified Madness project')
 if (typeof serviceKey !== 'string' || !serviceKey || typeof encryptionKey !== 'string' || encryptionKey.length < 32)
  throw new BackupCheckError('Existing backup and service-role credentials must be configured')
 if (githubRepository !== REPOSITORY || !validId(githubRunId) || typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha) || !validId(artifactId))
  throw new BackupCheckError('Verified repository, source revision, workflow run and uploaded artifact are required')
 if (!Array.isArray(archives) || archives.length !== 2 || SCHEMAS.some(schema => archives.filter(archive => archive?.schema === schema).length !== 1) || archives.some(archive => typeof archive.file !== 'string' || !archive.file))
  throw new BackupCheckError('Exactly one public and one sandbox encrypted archive are required')

 // Verify BOTH files before writing either success observation. A broken or
 // cross-schema archive must never advance even the first schema's timestamp.
 const verified = []
 for (const schema of SCHEMAS) {
  const archive = archives.find(archive => archive.schema === schema)
  let snapshot, result
  try {
   snapshot = decrypt(JSON.parse(await read(archive.file, 'utf8')), encryptionKey)
   if (snapshot?.schema !== schema || !validTime(snapshot.created_at)) throw new Error('Invalid snapshot identity')
   result = await verify(snapshot)
  } catch { throw new BackupCheckError(`Isolated ${schema} restore verification failed; no success was recorded`) }
  if (!Number.isSafeInteger(result?.tables) || result.tables < 1 || !Number.isSafeInteger(result.rows) || result.rows < 0)
   throw new BackupCheckError('Isolated restore coverage could not be verified')
  verified.push({ schema, snapshot_created_at: new Date(snapshot.created_at).toISOString(), tables: result.tables, rows: result.rows })
 }
 const checkedAt = now().toISOString()
 if (verified.some(result => Date.parse(result.snapshot_created_at) > Date.parse(checkedAt) + 300000))
  throw new BackupCheckError('Snapshot time is later than the restore observation')
 for (const result of verified) {
  const record = {
   key: KEY, status: 'done', attempts: 0, token: null, lease_until: null, last_error: null,
   last_success_at: checkedAt, updated_at: checkedAt, next_attempt_at: checkedAt,
   progress: { ...result, github_run_id: githubRunId, commit_sha: commitSha, artifact_id: artifactId, artifact_status: 'uploaded', verified_schemas: SCHEMAS },
  }
  let response
  try {
   response = await request(`${PROJECT_ORIGIN}/rest/v1/operation_runs?on_conflict=key`, {
    method: 'POST', redirect: 'error',
    headers: {
     apikey: serviceKey,
     ...(serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${serviceKey}` }),
     'Content-Type': 'application/json', 'Content-Profile': result.schema,
     Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(record), signal: AbortSignal.timeout(30000),
   })
  } catch { throw new BackupCheckError('Backup observation request failed') }
  if (!response.ok) throw new BackupCheckError(`Backup observation failed (HTTP ${response.status})`)
  let saved
  try { saved = await response.json() } catch { throw new BackupCheckError('Saved backup observation could not be verified') }
  const savedProgress = saved?.[0]?.progress
  if (!Array.isArray(saved) || saved.length !== 1 || saved[0]?.key !== KEY || saved[0].status !== 'done' || Date.parse(saved[0].last_success_at) !== Date.parse(checkedAt) || !savedProgress || Object.keys(savedProgress).length !== Object.keys(record.progress).length || Object.entries(record.progress).some(([key, value]) => JSON.stringify(savedProgress[key]) !== JSON.stringify(value)))
   throw new BackupCheckError('Saved backup observation could not be verified')
 }
 // Deliberately return only reviewed aggregate fields, never snapshot content.
 return { ok: true, checked_at: checkedAt, github_run_id: githubRunId, commit_sha: commitSha, artifact_id: artifactId, schemas: verified }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const result = await recordBackupChecks({
   supabaseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
   encryptionKey: process.env.BACKUP_ENCRYPTION_KEY, githubRepository: process.env.GITHUB_REPOSITORY,
   githubRunId: process.env.GITHUB_RUN_ID, commitSha: process.env.GITHUB_SHA, artifactId: process.env.BACKUP_ARTIFACT_ID,
   archives: SCHEMAS.map(schema => ({ schema, file: `work/backup-${schema}.json.enc` })),
  })
  console.log(JSON.stringify(result))
 } catch (error) {
  console.error(error instanceof BackupCheckError ? error.message : 'Backup verification could not be recorded')
  process.exitCode = 1
 }
}
