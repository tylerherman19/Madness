// Encrypted, consistent application backup. The envelope contains no plaintext records.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function encryptBackup(snapshot, passphrase) {
 if (!passphrase || passphrase.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters')
 const salt = randomBytes(16), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv)
 const plaintext = Buffer.from(JSON.stringify(snapshot))
 const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
 return { version: 1, algorithm: 'aes-256-gcm+scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}
export function decryptBackup(envelope, passphrase) {
 if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm+scrypt') throw new Error('Unsupported backup format')
 const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), 32), Buffer.from(envelope.iv, 'base64'))
 decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
 return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString())
}
export function snapshotDigest(snapshot) {
 return Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, { count: rows.length,
  sha256: createHash('sha256').update(JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b)))).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex') }]))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_ENCRYPTION_KEY } = process.env
 if (!SUPABASE_URL?.startsWith('https://') || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configure the intended Supabase project; credentials are never printed')
 const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/contest_backup`, { method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, ...(SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }), 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000) })
 if (!response.ok) throw new Error(`Backup failed (${response.status}); verify migration 024 and service access`)
 const snapshot = await response.json()
 const envelope = encryptBackup(snapshot, BACKUP_ENCRYPTION_KEY)
 const file = process.argv[2] ?? `work/backups/madness-${new Date().toISOString().replace(/[:.]/g,'-')}.json.enc`
 await mkdir(resolve(file, '..'), { recursive: true })
 await writeFile(file, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' })
 const roundtrip = decryptBackup(JSON.parse(await readFile(file, 'utf8')), BACKUP_ENCRYPTION_KEY)
 if (JSON.stringify(snapshotDigest(roundtrip)) !== JSON.stringify(snapshotDigest(snapshot))) throw new Error('Backup roundtrip verification failed')
 console.log('Encrypted backup written and authenticated. Run restore-check.mjs before declaring it restorable.')
}
