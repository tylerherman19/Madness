import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { randomBytes } from 'node:crypto'
import { encryptBackup } from './backup.mjs'
import { recordBackupChecks } from './record-backup-check.mjs'
import { PROJECT_ORIGIN, assertPrivateBucket, downloadArchive, objectName, pruneArchives, storageConfig, uploadArchive } from './backup-storage.mjs'

const SECRET = randomBytes(32).toString('base64')
const PRIVATE = 'private-person@example.test'
const NOW = new Date(Date.now() - 120000).toISOString()
const SNAPSHOT_TIME = new Date(Date.parse(NOW) - 300000).toISOString()
const CONFIG = {
 supabaseUrl: 'https://ugyimdqnyanmxayhdvje.supabase.co', serviceKey: 'fixture-service-role', encryptionKey: SECRET,
 githubRepository: 'tylerherman19/Madness', githubRunId: '123456', commitSha: 'a'.repeat(40), artifactId: '98765',
 archives: ['public', 'sandbox'].map(schema => ({ schema, file: `${schema}.enc` })),
 storage: { bucket: 'madness-backups', objects: { public: 'public/madness-public-20261110T103000Z-run123456.json.enc', sandbox: 'sandbox/madness-sandbox-20261110T103000Z-run123456.json.enc' } },
}
function fixture(overrides = {}) {
 const calls = [], verified = []
 const deps = {
  read: async file => JSON.stringify(encryptBackup({ version: 2, schema: file.split('.')[0], created_at: SNAPSHOT_TIME, tables: { players: [{ email: PRIVATE }] }, private: PRIVATE }, SECRET)),
  verify: async snapshot => { verified.push(snapshot.schema); return { tables: 27, rows: 2001, private: PRIVATE } },
  now: () => new Date(NOW),
  request: async (url, options) => {
   const record = JSON.parse(options.body)
   calls.push({ url, options, record })
   // PostgreSQL jsonb may return object keys in a different order.
   return { ok: true, json: async () => [{ ...record, progress: Object.fromEntries(Object.entries(record.progress).reverse()), private: PRIVATE }] }
  },
  ...overrides,
 }
 return { deps, calls, verified }
}

test('backup observations require both isolated restores, route each schema and exclude private data', async () => {
 const { deps, calls, verified } = fixture()
 const summary = await recordBackupChecks(CONFIG, deps)
 assert.deepEqual(verified, ['public', 'sandbox'])
 assert.deepEqual(calls.map(call => call.options.headers['Content-Profile']), ['public', 'sandbox'])
 assert.ok(calls.every(call => call.url === `${CONFIG.supabaseUrl}/rest/v1/operation_runs?on_conflict=key` && call.options.redirect === 'error'))
 assert.ok(calls.every(call => call.record.key === 'recovery:backup-restore' && call.record.status === 'done' && call.record.last_success_at === NOW))
 assert.deepEqual(calls.map(call => call.record.progress.schema), ['public', 'sandbox'])
 assert.ok(calls.every(call => call.record.progress.artifact_status === 'uploaded' && call.record.progress.artifact_id === CONFIG.artifactId))
 assert.ok(calls.every(call => JSON.stringify(call.record.progress.verified_schemas) === '["public","sandbox"]'))
 assert.equal(JSON.stringify({ summary, records: calls.map(call => call.record) }).includes(PRIVATE), false)
 assert.equal(JSON.stringify(summary).includes(SECRET), false)
})

test('wrong targets, incomplete schema coverage and missing upload provenance do not access files or send credentials', async () => {
 let accesses = 0
 const deps = { read: async () => { accesses++; throw new Error(PRIVATE) }, request: async () => { accesses++; throw new Error(SECRET) } }
 for (const supabaseUrl of ['https://other.supabase.co', `${CONFIG.supabaseUrl}.evil.test`, `${CONFIG.supabaseUrl}/elsewhere`, `${CONFIG.supabaseUrl}/?target=elsewhere`, 'https://user@ugyimdqnyanmxayhdvje.supabase.co'])
  await assert.rejects(recordBackupChecks({ ...CONFIG, supabaseUrl }, deps), /restricted to the verified Madness project/)
 for (const archives of [[CONFIG.archives[0]], [CONFIG.archives[0], CONFIG.archives[0]], [{ schema: 'private', file: 'private.enc' }, CONFIG.archives[1]]])
  await assert.rejects(recordBackupChecks({ ...CONFIG, archives }, deps), /one public and one sandbox/)
 for (const patch of [{ artifactId: undefined }, { githubRunId: 123456 }, { githubRepository: 'other/repository' }, { commitSha: 'not-a-source-revision' }])
  await assert.rejects(recordBackupChecks({ ...CONFIG, ...patch }, deps), /uploaded artifact are required/)
 for (const storage of [undefined, { bucket: 'madness-backups', objects: {} }, { ...CONFIG.storage, bucket: 'Public Bucket' }, { ...CONFIG.storage, objects: { ...CONFIG.storage.objects, sandbox: CONFIG.storage.objects.public } }])
  await assert.rejects(recordBackupChecks({ ...CONFIG, storage }, deps), /private storage location/)
 for (const encryptionKey of ['fixture-only-backup-passphrase-123456789', 'x'.repeat(44), undefined])
  await assert.rejects(recordBackupChecks({ ...CONFIG, encryptionKey }, deps), /credentials must be configured/)
 assert.equal(accesses, 0)
})

test('a corrupt, mismatched or failed second restore cannot advance either schema success timestamp', async () => {
 for (const failure of ['cross-schema', 'decrypt', 'restore']) {
  const good = fixture()
  const broken = fixture({
   read: async file => failure === 'decrypt' && file === 'sandbox.enc' ? '{}' : good.deps.read(failure === 'cross-schema' && file === 'sandbox.enc' ? 'public.enc' : file),
   verify: async snapshot => { if (failure === 'restore' && snapshot.schema === 'sandbox') throw new Error(PRIVATE); return { tables: 27, rows: 2001 } },
  })
  await assert.rejects(recordBackupChecks(CONFIG, broken.deps), /^Error: Isolated sandbox restore verification failed; no success was recorded$/)
  assert.equal(broken.calls.length, 0)
 }
})

test('database and transport failures never read or expose error bodies', async () => {
 let bodyRead = false
 const failing = fixture({ request: async () => ({ ok: false, status: 503, json: async () => { bodyRead = true; return { private: PRIVATE } } }) })
 await assert.rejects(recordBackupChecks(CONFIG, failing.deps), /^Error: Backup observation failed \(HTTP 503\)$/)
 assert.equal(bodyRead, false)
 const transport = fixture({ request: async () => { throw new Error(SECRET) } })
 await assert.rejects(recordBackupChecks(CONFIG, transport.deps), /^Error: Backup observation request failed$/)
 const malformed = fixture({ request: async () => ({ ok: true, json: async () => ({ private: PRIVATE }) }) })
 await assert.rejects(recordBackupChecks(CONFIG, malformed.deps), /^Error: Saved backup observation could not be verified$/)
})

test('restore observations record the private storage location of each archive', async () => {
 const { deps, calls } = fixture()
 await recordBackupChecks(CONFIG, deps)
 assert.deepEqual(calls.map(call => [call.record.progress.storage, call.record.progress.storage_bucket, call.record.progress.storage_object]), [
  ['supabase-private-bucket', 'madness-backups', CONFIG.storage.objects.public],
  ['supabase-private-bucket', 'madness-backups', CONFIG.storage.objects.sandbox],
 ])
})

// Private Supabase Storage: no public artifact fallback, fixed project, private bucket only.
const STORAGE = { supabaseUrl: PROJECT_ORIGIN, serviceKey: 'fixture-service-role', bucket: 'madness-backups' }
function storageFake(bucket = { id: 'madness-backups', name: 'madness-backups', public: false }, objects = {}) {
 const calls = []
 const request = async (url, options = {}) => {
  calls.push({ url, options })
  const path = new URL(url).pathname
  if (path === '/storage/v1/bucket/madness-backups') return bucket ? { ok: true, status: 200, json: async () => bucket } : { ok: false, status: 404, json: async () => { throw new Error('body must not be read') } }
  if (path.startsWith('/storage/v1/object/list/')) {
   const { prefix, offset } = JSON.parse(options.body)
   return { ok: true, status: 200, json: async () => offset ? [] : (objects[prefix] ?? []) }
  }
  if (path.startsWith('/storage/v1/object/madness-backups/')) {
   if (options.method === 'POST') { objects.stored = options.body; return { ok: true, status: 200, json: async () => ({}) } }
   return { ok: true, status: 200, arrayBuffer: async () => objects.stored }
  }
  if (path === '/storage/v1/object/madness-backups' && options.method === 'DELETE') return { ok: true, status: 200, json: async () => [] }
  return { ok: false, status: 500 }
 }
 return { calls, request }
}

test('backup storage refuses to run without a configured, existing, private bucket in the Madness project', async () => {
 for (const bucket of [undefined, '', 'Bad Bucket!'])
  assert.throws(() => storageConfig({ ...STORAGE, bucket }), /BACKUP_STORAGE_BUCKET.*No backup was published/)
 for (const supabaseUrl of ['https://other.supabase.co', `${PROJECT_ORIGIN}.evil.test`, `${PROJECT_ORIGIN}/x`])
  assert.throws(() => storageConfig({ ...STORAGE, supabaseUrl }), /restricted to the verified Madness project/)
 assert.throws(() => storageConfig({ ...STORAGE, serviceKey: '' }), /SERVICE_ROLE_KEY/)
 const config = storageConfig(STORAGE)
 await assert.rejects(assertPrivateBucket(config, storageFake(null).request), /not available to the service role \(HTTP 404\); create it as a private bucket/)
 await assert.rejects(assertPrivateBucket(config, storageFake({ id: 'madness-backups', public: true }).request), /is public; make it private/)
 await assert.rejects(assertPrivateBucket(config, storageFake({ id: 'madness-backups' }).request), /is public/)
 const ok = storageFake()
 assert.equal(await assertPrivateBucket(config, ok.request), true)
 assert.equal(ok.calls[0].options.headers.Authorization, 'Bearer fixture-service-role')
 assert.equal(storageConfig({ ...STORAGE, serviceKey: 'sb_secret_fixture' }).headers.Authorization, undefined)
})

test('encrypted archives upload without overwrite, download byte-for-byte, and prune only old archives of this workflow', async () => {
 const config = storageConfig(STORAGE)
 const name = objectName('public', '123456', new Date('2026-11-10T10:30:00.456Z'))
 assert.equal(name, 'public/madness-public-20261110T103000Z-run123456.json.enc')
 assert.throws(() => objectName('private', '1'), /schema and workflow run id/)
 const bytes = Buffer.from(JSON.stringify(encryptBackup({ version: 2, schema: 'public', created_at: SNAPSHOT_TIME, tables: { players: [{ email: PRIVATE }] } }, SECRET)))
 assert.equal(bytes.includes(PRIVATE), false)
 const fake = storageFake()
 const stored = await uploadArchive(config, name, bytes, fake.request)
 const upload = fake.calls.at(-1)
 assert.equal(upload.url, `${PROJECT_ORIGIN}/storage/v1/object/madness-backups/${name}`)
 assert.equal(upload.options.headers['x-upsert'], 'false')
 assert.equal(upload.options.redirect, 'error')
 assert.equal(stored.bytes, bytes.length)
 assert.deepEqual(await downloadArchive(config, name, fake.request), bytes)

 const now = new Date('2026-11-30T00:00:00Z')
 const old = '2026-11-01T00:00:00Z', recent = '2026-11-25T00:00:00Z'
 const prune = storageFake(undefined, {
  public: [{ name: 'madness-public-20261101T103000Z-run1.json.enc', created_at: old }, { name: 'madness-public-20261125T103000Z-run2.json.enc', created_at: recent }, { name: 'owner-notes.txt', created_at: old }],
  sandbox: [{ name: 'madness-sandbox-20261101T103000Z-run1.json.enc', created_at: old }, { name: 'madness-public-20261101T103000Z-run9.json.enc', created_at: old }],
 })
 const removed = await pruneArchives(config, { now, keep: ['sandbox/madness-sandbox-20261101T103000Z-run1.json.enc'] }, prune.request)
 assert.deepEqual(removed, ['public/madness-public-20261101T103000Z-run1.json.enc'])
 assert.deepEqual(JSON.parse(prune.calls.at(-1).options.body), { prefixes: removed })
 const failing = async () => ({ ok: false, status: 403, json: async () => { throw new Error('error bodies are never read') } })
 await assert.rejects(uploadArchive(config, name, bytes, failing), /^Error: Encrypted backup upload failed \(HTTP 403\)$/)
})

test('the backup workflow never publishes workflow artifacts and checks private storage before backing up', async () => {
 const workflow = await readFile('.github/workflows/backup.yml', 'utf8')
 assert.doesNotMatch(workflow, /upload-artifact/)
 assert.ok(workflow.indexOf('backup-storage.mjs preflight') < workflow.indexOf('node scripts/backup.mjs'))
 assert.ok(workflow.indexOf('backup-storage.mjs download') < workflow.indexOf('record-backup-check.mjs'))
 assert.ok(workflow.indexOf('record-backup-check.mjs') < workflow.indexOf('backup-storage.mjs prune'))
})

const require = createRequire(import.meta.url)
async function recoveryMarkup(record, { error = null, sandbox = false } = {}) {
 const queries = []
 const db = { from(table) {
  const query = { table, key: null }
  queries.push(query)
  const chain = {
   select: () => chain, order: () => chain,
   eq: (field, value) => { if (field === 'key') query.key = value; return chain },
   range: async () => ({ data: [], error: null }),
   limit: () => chain,
   maybeSingle: async () => table === 'operation_runs' ? { data: record, error } : { data: table === 'delivery_settings' ? { mode: 'record-only' } : null, error: null },
  }
  return chain
 } }
 const source = await readFile('src/app/admin/system/[view]/page.tsx', 'utf8')
 const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
 const compiledModule = { exports: {} }
 const imports = {
  'next/link': { default: ({ href, children }) => React.createElement('a', { href }, children) },
  'next/navigation': { redirect: () => { throw new Error('Unexpected redirect') }, notFound: () => { throw new Error('Unexpected missing view') } },
  '@/lib/session': { getAdminSession: async () => true },
  '@/lib/testMode': { getDb: async () => db, isTestMode: async () => sandbox },
  '../Actions': { default: () => null }, '../../operations/Controls': { default: () => null },
 }
 new Function('require', 'module', 'exports', code)(name => imports[name] ? { __esModule: true, ...imports[name] } : require(name), compiledModule, compiledModule.exports)
 const tree = await compiledModule.exports.default({ params: Promise.resolve({ view: 'recovery' }), searchParams: Promise.resolve({ page: '99' }) })
 return { markup: renderToStaticMarkup(tree), queries }
}
async function observation() {
 const { deps, calls } = fixture()
 await recordBackupChecks(CONFIG, deps)
 return calls[0].record
}

test('Recovery renders real restore coverage and fixed run/source links independently of job pagination', async () => {
 const { markup, queries } = await recoveryMarkup(await observation())
 assert.match(markup, /27 tables/)
 assert.match(markup, /2001 rows reconciled/)
 assert.match(markup, /Public and sandbox/)
 assert.match(markup, /https:\/\/github.com\/tylerherman19\/Madness\/actions\/runs\/123456/)
 assert.match(markup, new RegExp(`https://github.com/tylerherman19/Madness/commit/${CONFIG.commitSha}`))
 assert.ok(queries.some(query => query.table === 'operation_runs' && query.key === 'recovery:backup-restore'))
 assert.doesNotMatch(markup, /not verified in this environment|private-person/)
})

test('Recovery shows Unknown for missing, failed, malformed or cross-schema evidence', async () => {
 const record = await observation()
 for (const [value, options] of [
  [null, {}], [record, { error: { message: PRIVATE } }], [record, { sandbox: true }],
  [{ ...record, status: 'failed' }, {}],
  [{ ...record, progress: { ...record.progress, github_run_id: '../../untrusted' } }, {}],
  [{ ...record, progress: { ...record.progress, verified_schemas: ['public'] } }, {}],
 ]) {
  const { markup } = await recoveryMarkup(value, options)
  assert.match(markup, /<strong>Unknown<\/strong>/)
  assert.doesNotMatch(markup, /actions\/runs\/123456|private-person|last observed backup/i)
 }
})
