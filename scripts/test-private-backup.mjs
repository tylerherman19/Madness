// SEC-01 / REL-06: the private backup copy is created only in a private
// bucket, is not readable without credentials, restores in isolation, survives
// a key rotation, and old copies are pruned while recent ones are kept.
import assert from 'node:assert/strict'
import { encryptBackup, decryptBackupWithKeys } from './backup.mjs'
import { storeAndVerify, pruneArchives, BUCKET } from './private-backup.mjs'

const URL_ = 'https://project.supabase.co'
const KEY = 'sb_secret_fixture'
const OLD = 'fixture-only-old-backup-passphrase-0123456789'
const NEW = 'fixture-only-new-backup-passphrase-0123456789'

function storage({ publicBucket = false, exposeObjects = false } = {}) {
  const state = { bucket: null, objects: new Map(), calls: [] }
  const request = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? 'GET', h = options.headers ?? {}
    state.calls.push({ path: u.pathname, method, authorized: h.apikey === KEY, bearer: 'Authorization' in h })
    const ok = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
    const authed = h.apikey === KEY
    if (u.pathname === `/storage/v1/bucket/${BUCKET}`) return authed && state.bucket ? ok(state.bucket) : ok({ error: 'not found' }, 404)
    if (u.pathname === '/storage/v1/bucket' && method === 'POST') { state.bucket = { id: BUCKET, public: publicBucket || JSON.parse(options.body).public }; return ok({ name: BUCKET }) }
    if (u.pathname.startsWith(`/storage/v1/object/public/${BUCKET}/`)) return exposeObjects ? ok(state.objects.get(u.pathname.split(`${BUCKET}/`)[1])) : ok({ error: 'not found' }, 400)
    if (u.pathname.startsWith(`/storage/v1/object/list/${BUCKET}`)) {
      const prefix = JSON.parse(options.body).prefix.replace(/\/$/, '')
      const names = new Set()
      for (const path of state.objects.keys()) if (path.startsWith(prefix + '/')) names.add(path.slice(prefix.length + 1).split('/')[0])
      return ok([...names].map(name => ({ name })))
    }
    if (u.pathname === `/storage/v1/object/${BUCKET}` && method === 'DELETE') { for (const p of JSON.parse(options.body).prefixes) state.objects.delete(p); return ok([]) }
    if (u.pathname.startsWith(`/storage/v1/object/${BUCKET}/`)) {
      const path = u.pathname.split(`${BUCKET}/`)[1]
      if (!authed) return exposeObjects ? ok(state.objects.get(path)) : ok({ error: 'unauthorized' }, 400)
      if (method === 'POST') { if (state.objects.has(path)) return ok({}, 409); state.objects.set(path, options.body); return ok({ Key: path }) }
      return state.objects.has(path) ? ok(state.objects.get(path)) : ok({}, 404)
    }
    return ok({}, 404)
  }
  return { state, request }
}

const snapshot = schema => ({ version: 2, schema, created_at: new Date().toISOString(), tables: { players: [{ id: 1, email: 'private@example.test' }] } })
const files = { public: 'public.enc', sandbox: 'sandbox.enc' }
const archives = key => Object.fromEntries(Object.keys(files).map(schema => [files[schema], JSON.stringify(encryptBackup(snapshot(schema), key))]))
const read = contents => async file => contents[file]
const verify = async snap => ({ tables: Object.keys(snap.tables).length, rows: 1 })

// 1. Happy path: private bucket created, both copies stored and restored.
{
  const s = storage()
  const result = await storeAndVerify({ url: URL_, key: KEY, keys: [NEW], runId: '42', files }, { request: s.request, read: read(archives(NEW)), verify })
  assert.equal(s.state.bucket.public, false)
  assert.equal(s.state.objects.size, 2)
  assert.deepEqual(result.schemas.map(r => r.schema), ['public', 'sandbox'])
  assert.ok(!JSON.stringify(result).includes('private@example.test'), 'summary never carries backup content')
  assert.ok(s.state.calls.filter(c => c.authorized).every(c => !c.bearer), 'sb_secret keys are not sent as a bearer token')
  console.log('PASS private bucket created, both archives stored, read back and restored in isolation')
}
// 2. Refuses a public bucket or an object readable without credentials.
await assert.rejects(storeAndVerify({ url: URL_, key: KEY, keys: [NEW], runId: '43', files }, { request: storage({ publicBucket: true }).request, read: read(archives(NEW)), verify }), /missing or public/)
await assert.rejects(storeAndVerify({ url: URL_, key: KEY, keys: [NEW], runId: '44', files }, { request: storage({ exposeObjects: true }).request, read: read(archives(NEW)), verify }), /readable without credentials/)
console.log('PASS refuses to use a public bucket or a publicly readable object')
// 3. Key rotation: archives made with the old key still decrypt and verify.
{
  const s = storage()
  await storeAndVerify({ url: URL_, key: KEY, keys: [NEW, OLD], runId: '45', files }, { request: s.request, read: read(archives(OLD)), verify })
  assert.throws(() => decryptBackupWithKeys(JSON.parse(archives(OLD)[files.public]), [NEW]))
  console.log('PASS archives under the previous key still decrypt after rotation (BACKUP_ENCRYPTION_KEY_PREVIOUS)')
}
// 4. Retention: copies older than 30 days go, but at least 7 days are kept.
{
  const s = storage()
  const day = n => new Date(Date.UTC(2099, 0, 1) + n * 86400000).toISOString().slice(0, 10)
  for (let n = 0; n < 40; n++) s.state.objects.set(`daily/${day(n)}/9/backup-public.json.enc`, 'x')
  const removed = await pruneArchives({ url: URL_, key: KEY }, new Date(Date.UTC(2099, 0, 1) + 40 * 86400000), s.request)
  assert.equal(removed.length, 10)
  assert.equal(s.state.objects.size, 30)
  const sparse = storage()
  for (let n = 0; n < 5; n++) sparse.state.objects.set(`daily/${day(n)}/9/backup-public.json.enc`, 'x')
  assert.deepEqual(await pruneArchives({ url: URL_, key: KEY }, new Date(Date.UTC(2100, 0, 1)), sparse.request), [])
  console.log('PASS retention keeps 30 days and never fewer than the newest 7 days')
}
