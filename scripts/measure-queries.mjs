#!/usr/bin/env node
// Counts database round trips per request against a LOCAL production build.
//
//   node scripts/measure-queries.mjs [--scenarios 1000x5,1000x70] [--out file] [--skip-build]
//
// It starts the fixture database (tests/support/database.mjs, a fake PostgREST
// over in-memory PGlite that counts every request) and `next start` pointed at
// it, seeds N entries x D past pick days, then reports database requests per
// request for the main routes. Nothing here can reach a hosted service: the app
// only knows the fixture's address, and upstream ESPN/odds calls are stubbed by
// tests/support/upstream.mjs.
import { spawn, execFileSync } from 'node:child_process'
import { rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const scenarios = opt('scenarios', '1000x5,1000x70').split(',').map((s) => s.split('x').map(Number))
const APP_PORT = Number(opt('app-port', process.env.E2E_APP_PORT ?? 3818))
const DB_PORT = Number(opt('db-port', process.env.E2E_DB_PORT ?? 55130))
const out = opt('out', null)
const WARM_REQUESTS = Number(opt('warm', 8))
const APP = `http://127.0.0.1:${APP_PORT}`
const DB = `http://127.0.0.1:${DB_PORT}`
const FUTURE_DAYS = 110

const lines = []
const log = (line = '') => { console.log(line); lines.push(line) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const appEnv = {
  ...process.env,
  SUPABASE_URL: DB,
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-only',
  SESSION_SECRET: 'fixture-only-signing-secret-at-least-32-characters',
  EMAILS_ENABLED: 'false',
  RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.alloc(32, 7).toString('base64'),
  RESEND_API_KEY: 're_fixture_only',
  AUTOMATION_V2_ENABLED: 'false',
  TOURNAMENT_RELIABILITY_ENABLED: 'true',
  NEXT_PUBLIC_APP_URL: APP,
  NODE_OPTIONS: `--import ${pathToFileURL(resolve('tests/support/upstream.mjs')).href}`,
}

async function waitFor(url, ms = 120000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return } catch {}
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${url}`)
}

const post = async (path, rows) => {
  const res = await fetch(`${DB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-seed': '1' }, body: JSON.stringify(rows) })
  if (!res.ok) throw new Error(`seed ${path}: ${await res.text()}`)
}
const batched = async (path, rows, size) => { for (let i = 0; i < rows.length; i += size) await post(path, rows.slice(i, i + size)) }

const ACTIVE = '00000000-0000-4000-8000-000000000001'
const PLAYER = '00000000-0000-4000-8000-000000000002'

// N entries (plus the fixture's two), D finished pick days before the active one,
// FUTURE_DAYS scheduled days after it. 10% of entries are eliminated along the way.
async function seed(entries, days) {
  await fetch(`${DB}/__test/reset`, { method: 'POST' })
  const day = 86_400_000
  const base = Date.parse('2099-01-01T00:00:00Z')
  const slates = [], games = []
  for (let d = 1; d <= days; d++) {
    const id = randomUUID(), date = new Date(base - (days - d + 1) * day)
    slates.push({ id, slate_number: d, slate_date: date.toISOString().slice(0, 10), season_year: 2099, is_active: false, locks_at: new Date(date.getTime() + 18 * 3600e3).toISOString() })
    for (let g = 0; g < 4; g++) games.push({ slate_id: id, espn_event_id: `h${d}-${g}`, home_team: `W${d}_${g}`, away_team: `L${d}_${g}`, tip_time: new Date(date.getTime() + 18 * 3600e3).toISOString(), result: 'home_win', status_state: 'post' })
    slates[slates.length - 1].__id = id
  }
  for (let f = 1; f <= FUTURE_DAYS; f++) {
    const id = randomUUID(), date = new Date(base + f * day)
    slates.push({ id, slate_number: days + 1 + f, slate_date: date.toISOString().slice(0, 10), season_year: 2099, is_active: false, locks_at: new Date(date.getTime() + 18 * 3600e3).toISOString() })
    games.push({ slate_id: id, espn_event_id: `f${f}`, home_team: `FA${f}`, away_team: `FB${f}`, tip_time: new Date(date.getTime() + 18 * 3600e3).toISOString(), result: 'pending', status_state: 'pre' })
  }
  await fetch(`${DB}/slates?id=eq.${ACTIVE}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slate_number: days + 1 }) })
  const past = slates.filter((s) => s.__id)
  for (const s of slates) delete s.__id
  await batched('/slates', slates, 200)
  await batched('/games', games, 500)

  const players = [], picks = [], out = []
  for (let i = 0; i < entries; i++) {
    const id = randomUUID()
    const eliminatedAt = i % 10 === 0 && days > 0 ? 1 + (i / 10) % days : null
    players.push({ id, full_name: `Entry ${String(i).padStart(5, '0')}`, email: `m${i}@example.test`, pin_hash: 'x', status: 'alive' })
    if (eliminatedAt) out.push([id, eliminatedAt])
    for (let d = 1; d <= days; d++) {
      if (eliminatedAt && d > eliminatedAt) break
      const lose = eliminatedAt === d
      picks.push({ player_id: id, slate_id: past[d - 1].id, team: `${lose ? 'L' : 'W'}${d}_${i % 4}`, seed: (i % 16) + 1 })
    }
    if (!eliminatedAt && i % 3 === 0) picks.push({ player_id: id, slate_id: ACTIVE, team: i % 2 ? 'A' : 'B', seed: null })
  }
  await batched('/players', players, 500)
  await batched('/picks', picks, 2000)
  // A database trigger refuses picks from eliminated entries, so they are marked out afterwards.
  const bySlate = new Map()
  for (const [id, n] of out) bySlate.set(n, [...(bySlate.get(n) ?? []), id])
  for (const [n, ids] of bySlate) for (let i = 0; i < ids.length; i += 50) {
    const res = await fetch(`${DB}/players?id=in.(${ids.slice(i, i + 50).join(',')})`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-fixture-seed': '1' }, body: JSON.stringify({ status: 'eliminated', elimination_slate: n, elimination_reason: 'Lost' }) })
    if (!res.ok) throw new Error('eliminate: ' + (await res.text()))
  }
  // The fixture's own signed-in player gets a past pick on every day too.
  const own = past.map((s, d) => ({ player_id: PLAYER, slate_id: s.id, team: `W${d + 1}_9`, seed: 3 }))
  await batched('/picks', own, 1000)
  return picks.length + own.length
}

const stats = async () => (await fetch(`${DB}/__test/stats`)).json()
const resetStats = () => fetch(`${DB}/__test/stats/reset`, { method: 'POST' })

async function measure(label, request, { warm = WARM_REQUESTS } = {}) {
  await resetStats()
  const first = await request()
  const cold = await stats()
  await resetStats()
  let size = first.size
  let status = first.status
  for (let i = 0; i < warm; i++) { const r = await request(); size = r.size; status = r.status }
  const warmStats = await stats()
  return { label, status, cold: cold.total, warm: warm ? +(warmStats.total / warm).toFixed(2) : null, bytes: size.raw, gzip: size.gzip, byTable: cold.byTable }
}

const get = (path, cookie) => async () => {
  const res = await fetch(`${APP}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, size: { raw: buf.length, gzip: gzipSync(buf).length } }
}

async function login() {
  const res = await fetch(`${APP}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'player+test@example.test', password: 'FixturePass123!' }) })
  if (!res.ok) throw new Error('login failed: ' + (await res.text()))
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

async function runScenario(entries, days) {
  rmSync('.next/cache/fetch-cache', { recursive: true, force: true })
  const children = []
  const db = spawn('node', ['tests/support/database.mjs'], { env: { ...process.env, E2E_DB_PORT: String(DB_PORT) }, stdio: 'ignore' })
  children.push(db)
  let app
  try {
    await waitFor(`${DB}/ready`)
    const rows = await seed(entries, days)
    app = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(APP_PORT)], { env: appEnv, stdio: 'ignore' })
    children.push(app)
    await waitFor(`${APP}/login`)
    const cookie = await login()
    log(`=== ${entries} entries x ${days} past pick days (${rows} stored picks, ${FUTURE_DAYS} future days) ===`)
    const results = []
    const queue = [
      ['home, signed out', get('/')],
      ['home, signed in', get('/', cookie)],
      ['/api/me, signed out', get('/api/me')],
      ['/api/me, signed in', get('/api/me', cookie)],
      ['/pick, signed in', get('/pick', cookie)],
      ['/grid', get('/grid')],
      ['/api/sweat', get('/api/sweat')],
      ['/api/sweat?x=1 (query string)', get('/api/sweat?x=1')],
      ['/api/live-scores', get('/api/live-scores')],
      ['/api/grid/export', get('/api/grid/export')],
    ]
    for (const [label, request] of queue) results.push(await measure(label, request))
    // Pick submission: one write, so no warm repeat. Switching the pick back and forth would hit the 30/min limit.
    const slateTeams = ['A', 'B']
    await resetStats()
    const res = await fetch(`${APP}/api/picks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ slate_id: ACTIVE, team: slateTeams[0] }) })
    const pickStats = await stats()
    results.push({ label: `POST /api/picks (HTTP ${res.status})`, status: res.status, cold: pickStats.total, warm: null, bytes: null, gzip: null, byTable: pickStats.byTable })

    const pad = (s, n) => String(s).padEnd(n)
    log(`${pad('route', 32)}${pad('HTTP', 6)}${pad('first request', 15)}${pad('warm avg', 10)}${pad('bytes', 10)}gzip`)
    for (const r of results) log(`${pad(r.label, 32)}${pad(r.status, 6)}${pad(r.cold, 15)}${pad(r.warm ?? '-', 10)}${pad(r.bytes ?? '-', 10)}${r.gzip ?? '-'}`)
    log('(first request = database requests on a cold server; warm avg = per request over the next ' + WARM_REQUESTS + ' back-to-back requests)')
    log()
    log('first-request breakdown by call:')
    for (const r of results) log(`  ${r.label}: ${Object.entries(r.byTable).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`)
    log()
  } finally {
    for (const child of children.reverse()) child.kill('SIGTERM')
    await sleep(500)
  }
}

if (!args.includes('--skip-build') && !existsSync('.next/BUILD_ID')) {
  log('building (next build)...')
  execFileSync('node', ['node_modules/next/dist/bin/next', 'build'], { env: appEnv, stdio: 'ignore' })
}
log(`measured ${new Date().toISOString()} against a local production build and an in-memory PGlite fixture`)
for (const [entries, days] of scenarios) await runScenario(entries, days)
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, lines.join('\n') + '\n') }
process.exit(0)
