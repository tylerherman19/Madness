// Local-only load test: refuses any target that is not 127.0.0.1/localhost.
// Usage (stack from scripts/sim/run-stack.sh, env from scripts/sim/env.sh):
//   node scripts/load-local.mjs seed | viewers 50,100,250 [secs] | rush <window_s> [lockmid] | recovery [secs]
import { SignJWT } from 'jose'
import { createHmac, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { APP, ADAPTER, assertLocal, sleep, percentile, nextIp } from './sim/lib.mjs'
import { seedSeason, ACTIVE } from '../tests/support/seedSeason.mjs'
assertLocal(APP); assertLocal(ADAPTER)
const OUT = 'docs/audits/evidence/load-local.txt'
const log = (t = '') => { appendFileSync(OUT, t + '\n'); console.log(t) }
const [mode, arg1, arg2] = process.argv.slice(2)
const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? 'fixture-only-signing-secret-at-least-32-characters')
const sqlq = async (sql, params = []) => (await (await fetch(`${ADAPTER}/__test/sql`, { method: 'POST', body: JSON.stringify({ sql, params }) })).json())
const stats = async () => (await fetch(`${ADAPTER}/__test/stats`)).json()
const statsReset = () => fetch(`${ADAPTER}/__test/stats/reset`, { method: 'POST' })
const loadavg = () => execSync('uptime').toString().trim().replace(/.*load averages?: /, '')
const nextPid = () => { try { return execSync(`lsof -ti tcp:${new URL(APP).port} -sTCP:LISTEN`).toString().trim().split('\n')[0] } catch { return null } }
const cpuOf = (pid) => { try { return Number(execSync(`ps -o %cpu= -p ${pid}`).toString()) } catch { return 0 } }

async function mintCookie(row) {
  const cv = createHmac('sha256', secret).update(row.pin_hash).digest('hex')
  const token = await new SignJWT({ player_id: row.id, full_name: row.full_name, is_admin: false, test_mode: false, purpose: 'player', credential_version: cv })
    .setJti(randomUUID()).setIssuer('madness').setAudience('madness:local').setIssuedAt().setProtectedHeader({ alg: 'HS256' }).setExpirationTime('30d').sign(secret)
  return `survivor_session=${token}`
}
async function entries() {
  const r = await sqlq(`select id, full_name, pin_hash, status from public.players where status='alive' order by email`)
  return Promise.all(r.rows.map(async (row, i) => ({ id: row.id, cookie: await mintCookie(row), ip: nextIp(), i })))
}

const ROUTES = [['/', 30], ['/api/live-scores', 25], ['/api/sweat', 15], ['/grid', 10], ['/api/me', 10], ['/schedule', 5], ['/sweat', 5]]
const pickRoute = () => { let r = Math.random() * 100; for (const [p, w] of ROUTES) { r -= w; if (r <= 0) return p } return '/' }

import http from 'node:http'
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity })
function timed(path, { cookie, ip, method = 'GET', body } = {}) {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null
    const url = new URL(path, APP)
    const req = http.request({ agent, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, timeout: 20000,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'x-real-ip': ip, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ path, status: res.statusCode, ms: performance.now() - t0, text: Buffer.concat(chunks).toString(), t0 }))
      res.on('error', (e) => resolve({ path, status: 'error', ms: performance.now() - t0, err: String(e).slice(0, 80), t0 }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ path, status: 'timeout', ms: performance.now() - t0, err: 'timeout', t0 }) })
    req.on('error', (e) => resolve({ path, status: 'error', ms: performance.now() - t0, err: String(e).slice(0, 80), t0 }))
    if (payload) req.write(payload)
    req.end()
  })
}
const summarize = (samples) => {
  const ms = samples.filter((s) => s.status === 200).map((s) => s.ms).sort((a, b) => a - b)
  return `${percentile(ms, 50).toFixed(0)}/${percentile(ms, 95).toFixed(0)}/${percentile(ms, 99).toFixed(0)} ms`
}

async function viewerStage(vus, secs, users) {
  await statsReset()
  const samples = [], end = performance.now() + secs * 1000
  const pid = nextPid(); const cpu = []
  const sampler = setInterval(() => cpu.push(cpuOf(pid)), 2000)
  const poolSamples = []
  const ps = setInterval(async () => poolSamples.push((await stats()).pool), 2000)
  const t0 = performance.now()
  await Promise.all(Array.from({ length: vus }, async (_, v) => {
    const signed = v % 5 === 0 ? users[v % users.length] : null
    const ip = signed?.ip ?? nextIp()
    await sleep(Math.random() * 2000)
    while (performance.now() < end) {
      samples.push(await timed(pickRoute(), { cookie: signed?.cookie, ip }))
      await sleep(1000 + Math.random() * 2000)
    }
  }))
  clearInterval(sampler); clearInterval(ps)
  const wall = (performance.now() - t0) / 1000
  const st = await stats()
  const bad = samples.filter((s) => s.status !== 200)
  log(`\n--- viewers ${vus} (80% signed out, 20% signed in), ${secs}s, load avg ${loadavg()}`)
  log(`requests ${samples.length}  req/s ${(samples.length / wall).toFixed(1)}  non-200 ${bad.length} (timeouts ${bad.filter((s) => s.status === 'timeout').length}, errors ${bad.filter((s) => s.status === 'error').length}, http ${bad.filter((s) => typeof s.status === 'number').length})  p50/p95/p99 ${summarize(samples)}`)
  for (const [p] of ROUTES) { const s = samples.filter((x) => x.path === p); log(`  ${p.padEnd(18)} n=${String(s.length).padStart(5)}  p50/p95/p99 ${summarize(s)}  non-200 ${s.filter((x) => x.status !== 200).length}`) }
  log(`  adapter db requests ${st.total} = ${(st.total / wall).toFixed(1)}/s; pool max busy ${st.pool.maxBusy}/10, max waiting ${st.pool.maxWaiting}, avg waiting ${(st.pool.waitSum / Math.max(1, st.pool.waitSamples)).toFixed(2)}, pg avg query ${(st.pool.queryMs / Math.max(1, st.pool.queries)).toFixed(1)} ms, avg acquire ${(st.pool.acquireMs / Math.max(1, st.pool.queries)).toFixed(1)} ms`)
  log(`  next cpu% avg ${(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(0)} max ${Math.max(0, ...cpu).toFixed(0)}`)
  const codes = {}; for (const b of bad) codes[b.status + (b.err ? ' ' + b.err : '')] = (codes[b.status + (b.err ? ' ' + b.err : '')] ?? 0) + 1
  if (bad.length) log(`  failures: ${JSON.stringify(codes)}`)
}

async function resetPicks() {
  await sqlq('delete from public.pick_requests'); await sqlq('delete from public.pick_revisions')
  await sqlq('delete from public.picks where slate_id=$1', [ACTIVE])
  await sqlq("update public.slates set locks_at='2099-01-01T18:00:00Z' where id=$1", [ACTIVE])
  await sqlq("update public.games set tip_time='2099-01-01T18:00:00Z' where slate_id=$1", [ACTIVE])
}

async function rush(windowSecs, lockMid, users, viewers = 250) {
  await resetPicks()
  await statsReset()
  const pid = nextPid(), cpu = []
  const sampler = setInterval(() => cpu.push(cpuOf(pid)), 2000)
  const poolSamples = []
  const ps = setInterval(async () => poolSamples.push((await stats()).pool), 2000)
  const results = [], vsamples = []
  const start = performance.now()
  let lockAt = null
  const vstop = { v: false }
  const vwork = Array.from({ length: viewers }, async (_, v) => { const signed = v % 5 === 0 ? users[(v * 7) % users.length] : null; const ip = nextIp(); while (!vstop.v) { vsamples.push(await timed(pickRoute(), { cookie: signed?.cookie, ip })); await sleep(1000 + Math.random() * 2000) } })
  if (lockMid) setTimeout(async () => { await sqlq('update public.slates set locks_at=now() where id=$1', [ACTIVE]); await sqlq('update public.games set tip_time=now() where slate_id=$1', [ACTIVE]); lockAt = (await sqlq('select now() as n')).rows[0].n; log(`  lock moved to ${lockAt} at +${((performance.now() - start) / 1000).toFixed(0)}s`) }, windowSecs * 500)
  await Promise.all(users.map(async (u, k) => {
    await sleep(Math.random() * windowSecs * 1000)
    const page = await timed('/pick', u)
    const team = k % 2 ? 'A' : 'B'
    const post = await timed('/api/picks', { ...u, method: 'POST', body: { slate_id: ACTIVE, team, request_id: randomUUID() } })
    let receipt = null; try { receipt = JSON.parse(post.text) } catch { /* */ }
    const rec = { u, page, post, team, receipt, finalTeam: post.status === 200 ? team : null, change: null }
    if (k % 5 === 0 && post.status === 200) {
      await sleep(500 + Math.random() * 3000)
      const other = team === 'A' ? 'B' : 'A'
      const ch = await timed('/api/picks', { ...u, method: 'POST', body: { slate_id: ACTIVE, team: other, request_id: randomUUID(), pick_id: receipt?.pick?.id, expected_version: receipt?.pick?.updated_at } })
      rec.change = ch; if (ch.status === 200) rec.finalTeam = other
    }
    results.push(rec)
  }))
  vstop.v = true; await Promise.all(vwork); clearInterval(sampler); clearInterval(ps)
  const wall = (performance.now() - start) / 1000
  const st = await stats()
  const posts = results.map((r) => r.post), pages = results.map((r) => r.page), changes = results.filter((r) => r.change).map((r) => r.change)
  log(`\n--- pre-lock rush: ${users.length} participants over ${windowSecs}s${lockMid ? ' (lock passes mid-run)' : ''}, ${viewers} viewers browsing, ${wall.toFixed(0)}s wall, load avg ${loadavg()}`)
  const tally = (arr) => { const t = {}; for (const s of arr) { let k = String(s.status); if (s.status !== 200) { let msg = ''; try { msg = JSON.parse(s.text).error } catch { msg = s.err ?? '' } k += ' ' + String(msg).slice(0, 70) } t[k] = (t[k] ?? 0) + 1 } return t }
  log(`  /pick page: ${JSON.stringify(tally(pages))} p50/p95/p99 ${summarize(pages)}`)
  log(`  submit:     ${JSON.stringify(tally(posts))} p50/p95/p99 ${summarize(posts)}`)
  log(`  change:     n=${changes.length} ${JSON.stringify(tally(changes))} p50/p95/p99 ${summarize(changes)}`)
  log(`  viewers: ${vsamples.length} requests, non-200 ${vsamples.filter((s) => s.status !== 200).length}, p50/p95/p99 ${summarize(vsamples)}`)
  log(`  success rate (submit 200): ${(100 * posts.filter((p) => p.status === 200).length / posts.length).toFixed(1)}%   db requests ${st.total} (${(st.total / wall).toFixed(0)}/s)  pool max busy ${st.pool.maxBusy}, max waiting ${st.pool.maxWaiting}, avg waiting ${(st.pool.waitSum / Math.max(1, st.pool.waitSamples)).toFixed(2)}  next cpu avg ${(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(0)}% max ${Math.max(0, ...cpu).toFixed(0)}%`)
  // database verification
  const rowsDb = (await sqlq(`select player_id, team, count(*) over (partition by player_id)::int n, updated_at from public.picks where slate_id=$1`, [ACTIVE])).rows
  const byPlayer = new Map(rowsDb.map((r) => [r.player_id, r]))
  const dup = rowsDb.filter((r) => r.n > 1).length
  let missing = 0, wrongTeam = 0
  for (const r of results) { if (r.post.status === 200) { const row = byPlayer.get(r.u.id); if (!row) missing++; else if (r.finalTeam && row.team !== r.finalTeam) wrongTeam++ } }
  const ok200 = results.filter((r) => r.post.status === 200).length
  log(`  DB check: ${rowsDb.length} pick rows; duplicates ${dup}; 200 responses without a row ${missing}; rows whose team differs from the last accepted request ${wrongTeam}; players with a row but no 200 ${rowsDb.length - ok200 + 0} (expect 0 unless a response was lost)`)
  if (lockMid) {
    const lock = (await sqlq(`select locks_at from public.slates where id=$1`, [ACTIVE])).rows[0].locks_at
    const after = (await sqlq(`select count(*)::int n from public.picks where slate_id=$1 and updated_at > $2::timestamptz`, [ACTIVE, lock])).rows[0].n
    log(`  lock check: picks with updated_at after the lock instant ${after} (expect 0); 200 responses ${ok200}, refused after lock ${posts.filter((p) => p.status !== 200).length}`)
  }
}

if (mode === 'seed') {
  const n = Number(arg1 ?? 1112)
  const picks = await seedSeason(ADAPTER, n, 5)
  const c = (await sqlq(`select count(*) filter (where status='alive')::int alive, count(*)::int total from public.players`)).rows[0]
  log(`seeded ${picks} picks; entries ${c.total} (${c.alive} alive), 5 finished days + future schedule`)
} else if (mode === 'viewers') {
  const users = await entries(); log(`\n===== ${new Date().toISOString()} viewer stages ${arg1} (latency ${process.env.FIXTURE_DB_LATENCY_MS ?? 0} ms)`)
  for (const v of arg1.split(',')) { await viewerStage(Number(v), Number(arg2 ?? 60), users); await sleep(5000) }
} else if (mode === 'rush') {
  const users = (await entries()).slice(0, 1000); log(`\n===== ${new Date().toISOString()} rush (latency ${process.env.FIXTURE_DB_LATENCY_MS ?? 0} ms)`)
  await rush(Number(arg1), arg2 === 'lockmid', users)
} else if (mode === 'recovery') {
  const secs = Number(arg1 ?? 120); log(`\n--- recovery: health and home every 2 s for ${secs}s`)
  const h = [], p = []; const end = Date.now() + secs * 1000
  while (Date.now() < end) { h.push(await timed('/api/health', { ip: nextIp() })); p.push(await timed('/', { ip: nextIp() })); await sleep(2000) }
  const slice = (a, i, j) => a.slice(i, j)
  for (const [name, a] of [['health', h], ['home', p]]) log(`  ${name}: first 30s ${summarize(slice(a, 0, 15))}, last 30s ${summarize(slice(a, -15))}, non-200 ${a.filter((s) => s.status !== 200).length}/${a.length}`)
}
