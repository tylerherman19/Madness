// Shared helpers for the local simulation and load scripts. Everything here talks
// to 127.0.0.1 only; assertLocal() refuses any other target.
import * as pg from 'pg'
import { appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const APP_PORT = Number(process.env.SIM_APP_PORT ?? 3917)
export const DB_PORT = Number(process.env.SIM_DB_PORT ?? 55231)
export const APP = process.env.SIM_APP_URL ?? `http://127.0.0.1:${APP_PORT}`
export const ADAPTER = `http://127.0.0.1:${DB_PORT}`
export const PG_URL = process.env.FIXTURE_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:55470/sim'
export const CRON_SECRET = process.env.CRON_SECRET ?? 'sim-cron-secret-local-only'

export function assertLocal(url) {
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error(`Refusing non-local target ${host}`)
  if (/vercel\.app|supabase\.co|madness-cyan/.test(url)) throw new Error('Refusing hosted target')
}
assertLocal(APP)
assertLocal(ADAPTER)
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(PG_URL)) throw new Error('Refusing non-local database')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ----------------------------------------------------------------- SQL
let client
export async function sql(text, params = []) {
  if (!client) {
    client = new pg.Client({ connectionString: PG_URL, application_name: 'sim-script' })
    await client.connect()
  }
  return client.query(text, params)
}
export const rows = async (text, params) => (await sql(text, params)).rows
export const scalar = async (text, params) => Object.values((await rows(text, params))[0] ?? {})[0]
export async function closeSql() { if (client) { await client.end(); client = null } }

// ---------------------------------------------------------------- HTTP
let ipCounter = 0
export const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}` }

export async function http(method, path, { cookie, body, ip, headers = {}, timeout = 60000, raw = false } = {}) {
  const started = performance.now()
  const res = await fetch(new URL(path, APP), {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      'x-real-ip': ip ?? '10.255.255.254',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  if (!raw && (res.headers.get('content-type') ?? '').includes('json')) { try { json = JSON.parse(text) } catch { /* not json */ } }
  return { status: res.status, text, json, headers: res.headers, ms: performance.now() - started }
}

export function cookieFrom(res, name) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';')
    if (pair.startsWith(`${name}=`)) return pair
  }
  return null
}

export async function pmap(items, concurrency, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

export const cron = (path, method = 'GET') => http(method, path, { headers: { Authorization: `Bearer ${CRON_SECRET}` }, timeout: 280000 })

// Run one durable worker workload. The minute scheduler would call this on its own
// cadence; the simulation clears the interval gate first (recorded in the log) and
// requires that the job actually ran (claimed:true), because an unclaimed call is a
// 200 that did nothing.
export async function worker(kind, { force = true } = {}) {
  if (force) await sql(`update public.operation_runs set next_attempt_at=clock_timestamp() where key=$1`, [`recurring:${kind}`])
  const res = await cron(`/api/cron/worker?workload=${kind}`)
  return { status: res.status, claimed: res.json?.claimed, ok: res.json?.ok, progress: res.json?.progress, body: res.json ?? res.text.slice(0, 300) }
}

// ----------------------------------------------------------------- evidence
export class Evidence {
  constructor(file) { this.file = file; this.pass = 0; this.fail = 0; this.failures = []; writeFileSync(file, '') }
  line(text) { appendFileSync(this.file, text + '\n'); console.log(text) }
  section(text) { this.line(`\n== ${text}`) }
  check(label, ok, detail = '') {
    if (ok) this.pass++; else { this.fail++; this.failures.push(label) }
    this.line(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  [${detail}]` : ''}`)
    return ok
  }
  note(text) { this.line(`NOTE  ${text}`) }
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// --------------------------------------------------------------- fake ESPN
export const espnFile = () => join(tmpdir(), `madness-fake-espn-${DB_PORT}.json`)
export function writeEspn(byDate, rankings) {
  writeFileSync(espnFile(), JSON.stringify({ ...byDate, ...(rankings ? { rankings } : {}) }))
}
export const espnExists = () => existsSync(espnFile())

const CENTRAL = 'America/Chicago'
export const centralDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: CENTRAL }).format(date)
export const centralHour = (date = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, hour: 'numeric', hour12: false }).format(date)) % 24
export const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
// The instant that is HH:MM Central on the given Central calendar date.
export function centralInstant(isoDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  for (let offset = 4; offset <= 8; offset++) {
    const guess = new Date(Date.UTC(...isoDate.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), h + offset, m))
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CENTRAL, hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(guess)
    const get = (t) => parts.find((p) => p.type === t).value
    if (`${get('year')}-${get('month')}-${get('day')}` === isoDate && `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` === hhmm) return guess
  }
  throw new Error(`no instant for ${isoDate} ${hhmm}`)
}
