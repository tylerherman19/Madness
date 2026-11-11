// Encrypted, consistent application backup. The envelope contains no plaintext records.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// BACKUP_ENCRYPTION_KEY is 32 random bytes, written as 64 hex characters or
// base64 (`openssl rand -base64 32`). It is used directly as the AES-256 key, so
// there is no passphrase stretching to tune; passphrases are refused.
export class BackupKeyError extends Error {}
export function parseBackupKey(value) {
 const help = 'BACKUP_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters or base64; generate one with: openssl rand -base64 32'
 if (typeof value !== 'string' || !value) throw new BackupKeyError(help)
 const text = value.trim()
 let key
 if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, 'hex')
 else if (/^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9_-]{43}$/.test(text)) {
  // Random base64 mixes upper- and lower-case letters; words and phrases rarely fit 43 characters of it.
  if (!/[A-Z]/.test(text) || !/[a-z]/.test(text)) throw new BackupKeyError(`${help} (the value looks like a passphrase, not random bytes)`)
  key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
 } else throw new BackupKeyError(help)
 if (key.length !== 32 || new Set(key).size < 16) throw new BackupKeyError(`${help} (the value is not random enough)`)
 return key
}
const aad = envelope => Buffer.from(`madness-backup:v2:${envelope.schema}:${envelope.created_at}`)
function decipherFor(key, iv, tag) {
 // Fixed 96-bit nonce and full 128-bit tag; Node would otherwise accept a truncated tag.
 if (iv.length !== 12 || tag.length !== 16) throw new Error('Corrupt backup envelope')
 const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
 decipher.setAuthTag(tag)
 return decipher
}
export function encryptBackup(snapshot, encodedKey) {
 const key = parseBackupKey(encodedKey)
 if (!['public', 'sandbox'].includes(snapshot?.schema) || typeof snapshot.created_at !== 'string') throw new Error('Backup snapshot identity is missing')
 // A fresh random nonce per archive; a key never encrypts two archives with the same nonce.
 const header = { version: 2, algorithm: 'aes-256-gcm', schema: snapshot.schema, created_at: snapshot.created_at, iv: randomBytes(12).toString('base64') }
 const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'), { authTagLength: 16 })
 // Schema and creation time travel in clear (for retention and routing) but are authenticated.
 cipher.setAAD(aad(header))
 const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(snapshot))), cipher.final()])
 return { ...header, tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}
export function decryptBackup(envelope, encodedKey) {
 if (envelope?.version === 2 && envelope.algorithm === 'aes-256-gcm') {
  const decipher = decipherFor(parseBackupKey(encodedKey), Buffer.from(envelope.iv ?? '', 'base64'), Buffer.from(envelope.tag ?? '', 'base64'))
  decipher.setAAD(aad(envelope))
  const snapshot = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext ?? '', 'base64')), decipher.final()]).toString())
  if (snapshot?.schema !== envelope.schema || snapshot?.created_at !== envelope.created_at) throw new Error('Backup envelope does not match its contents')
  return snapshot
 }
 // Archives written before November 2026 used an scrypt-stretched passphrase.
 // Decrypt them with that original passphrase; new archives are never written this way.
 if (envelope?.version === 1 && envelope.algorithm === 'aes-256-gcm+scrypt') {
  if (typeof encodedKey !== 'string' || !encodedKey) throw new BackupKeyError('The original backup passphrase is required for a version 1 archive')
  const decipher = decipherFor(scryptSync(encodedKey, Buffer.from(envelope.salt, 'base64'), 32), Buffer.from(envelope.iv, 'base64'), Buffer.from(envelope.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString())
 }
 throw new Error('Unsupported backup format')
}
export function snapshotDigest(snapshot) {
 return Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, { count: rows.length,
  sha256: createHash('sha256').update(JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b)))).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex') }]))
}
export async function fetchBackupSnapshot({ url, serviceKey, schema = 'public' }, request = fetch) {
 if (!['public', 'sandbox'].includes(schema)) throw new Error('SUPABASE_BACKUP_SCHEMA must be public or sandbox')
 if (!url?.startsWith('https://') || !serviceKey) throw new Error('Configure the intended Supabase project; credentials are never printed')
 const response = await request(`${url}/rest/v1/rpc/contest_backup`, { method: 'POST', headers: { apikey: serviceKey, ...(serviceKey.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${serviceKey}` }), 'Content-Type': 'application/json', 'Content-Profile': schema }, body: '{}', signal: AbortSignal.timeout(120000) })
 if (!response.ok) throw new Error(`Backup failed (${response.status}); verify migration 024 and service access`)
 const snapshot = await response.json()
 // A successful HTTP response from the wrong exposed schema is not a backup
 // of the requested contest. Reject it before encryption or writing an archive.
 if (snapshot?.schema !== schema) throw new Error('Backup schema mismatch; no archive was written')
 return snapshot
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_ENCRYPTION_KEY, SUPABASE_BACKUP_SCHEMA = 'public' } = process.env
 parseBackupKey(BACKUP_ENCRYPTION_KEY) // refuse a weak key before reading any rows
 const snapshot = await fetchBackupSnapshot({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY, schema: SUPABASE_BACKUP_SCHEMA })
 const envelope = encryptBackup(snapshot, BACKUP_ENCRYPTION_KEY)
 const file = process.argv[2] ?? `work/backups/madness-${SUPABASE_BACKUP_SCHEMA}-${new Date().toISOString().replace(/[:.]/g,'-')}.json.enc`
 await mkdir(resolve(file, '..'), { recursive: true })
 await writeFile(file, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' })
 const roundtrip = decryptBackup(JSON.parse(await readFile(file, 'utf8')), BACKUP_ENCRYPTION_KEY)
 if (JSON.stringify(snapshotDigest(roundtrip)) !== JSON.stringify(snapshotDigest(snapshot))) throw new Error('Backup roundtrip verification failed')
 console.log('Encrypted backup written and authenticated. Run restore-check.mjs before declaring it restorable.')
}
