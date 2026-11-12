// Part A: tournament simulation with 1,000 entries, driven through the HTTP API and the
// cron/worker endpoints. Requires the stack from scripts/sim/run-stack.sh.
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import {
  Evidence, http, cookieFrom, pmap, nextIp, sql, rows, scalar, worker, cron, sleep, centralHour, closeSql,
} from './lib.mjs'
import * as W from './world.mjs'

const N = Number(process.env.SIM_ENTRIES ?? 1000)
const REAL_SIGNUPS = Number(process.env.SIM_REAL_SIGNUPS ?? 100)
const ev = new Evidence('docs/audits/evidence/simulation-run.txt')
const E = (label, ok, detail) => ev.check(label, ok, detail)
if (centralHour() >= 23) throw new Error('Run before 8 PM Central: pick windows are placed on today')

// ------------------------------------------------------------------ setup
ev.line(`Simulation start ${new Date().toISOString()} entries=${N} (real HTTP signups: ${REAL_SIGNUPS}, rest seeded by SQL with a cheap bcrypt cost)`)
W.reseed(20260319)
W.buildR1(); W.assignIds()
W.sim.today = (await import('./lib.mjs')).centralDate()
W.sim.rankings = { E01: 1, W01: 2, S01: 3, M01: 4, E02: 6, W02: 7, S02: 8, M02: 9, E03: 12, W03: 13 }
// decide every round-one result now; later rounds are built as earlier ones finish
for (const g of W.games) g.truth = W.decide(g)
await W.applyCalendar(0, 'pre') // nothing stored yet: only writes the fake ESPN file

const admin = { cookie: null }
{
  const res = await http('POST', '/api/auth/admin', { body: { password: 'SimAdminPass1!' }, ip: '10.200.0.1' })
  admin.cookie = (await import('./lib.mjs')).cookieFrom(res, 'survivor_admin')
  E('admin signs in over HTTP', res.status === 200 && !!admin.cookie, `status ${res.status}`)
}
const A = (method, path, body) => http(method, path, { cookie: admin.cookie, body, ip: '10.200.0.2' })

// ---- step 1: start the contest with the admin flow
ev.section('Step 1: start a March Madness contest (admin flow)')
const pool0 = (await rows('select * from public.pools where is_active'))[0]
for (const d of [0, 1]) {
  const date = new Date(Date.parse(`${W.sim.today}T12:00:00Z`) + d * 86400e3).toISOString().slice(0, 10)
  const res = await A('POST', '/api/schedule/sync-espn', { date, season_year: pool0.season_year })
  E(`admin syncs tournament day ${d + 1} from the (fake) feed`, res.status === 200, `status ${res.status} ${res.text.slice(0, 120)}`)
}
const day0 = (await rows(`select s.id from public.slates s join public.games g on g.slate_id=s.id where g.espn_event_id=$1`, [W.gamesOfDay(0)[0].espnId]))[0]
{
  const res = await A('POST', '/api/admin/start-tournament', { pool_id: pool0.id, slate_id: day0.id, confirmation: 'START FRESH', reason: 'Simulation start' })
  E('start route archives the old contest and opens the tournament', res.status === 200 && res.json?.ok, `status ${res.status} ${res.text.slice(0, 150)}`)
  const pool = (await rows('select * from public.pools where is_active'))[0]
  E('new pool is march-madness, tournament-round, highest-seed', pool.competition_mode === 'march-madness' && pool.pick_frequency === 'tournament-round' && pool.auto_pick_behavior === 'highest-seed', `${pool.competition_mode}/${pool.pick_frequency}/${pool.auto_pick_behavior}`)
  E('active slate is round one day one, no entries remain', (await scalar('select count(*)::int from public.players')) === 0)
}

// slates by day
const slateOfDay = {}
async function mapSlates() {
  for (const r of await rows(`select g.espn_event_id, g.slate_id from public.games g where g.espn_event_id = any($1)`, [W.games.map((g) => g.espnId)])) {
    const game = W.games.find((g) => g.espnId === r.espn_event_id)
    slateOfDay[game.day] = r.slate_id
    game.dbSlate = r.slate_id
  }
}
await mapSlates()

// ---- step 2: participants
ev.section(`Step 2: ${N} participants register and sign in`)
const players = Array.from({ length: N }, (_, i) => ({
  i, name: `Sim Entry ${String(i).padStart(4, '0')}`, email: `sim${i}@example.test`, password: 'SimPass1234!', ip: nextIp(),
  used: new Set(), seeds: new Set(), picks: [], alive: true, cookie: null, id: null,
}))
{
  const t0 = performance.now()
  const real = players.slice(0, REAL_SIGNUPS)
  const results = await pmap(real, 6, (p) => http('POST', '/api/signup', { ip: p.ip, body: { full_name: p.name, email: p.email, phone: '5550100' + String(p.i).padStart(3, '0'), venmo: '@sim' + p.i, password: p.password } }))
  E(`${REAL_SIGNUPS} entries register over HTTP`, results.every((r) => r.status === 200), `statuses ${[...new Set(results.map((r) => r.status))]} in ${((performance.now() - t0) / 1000).toFixed(0)}s`)
  const dup = await http('POST', '/api/signup', { ip: nextIp(), body: { full_name: 'Dup', email: players[0].email.toUpperCase(), phone: '5550100999', venmo: '@dup', password: 'SimPass1234!' } })
  E('duplicate email (case variant) is refused', dup.status === 409, `status ${dup.status}`)
  const hash = bcrypt.hashSync('SimPass1234!', 4)
  const rest = players.slice(REAL_SIGNUPS)
  for (let i = 0; i < rest.length; i += 200) {
    const chunk = rest.slice(i, i + 200)
    await sql(`insert into public.players(full_name,email,pin_hash,status,phone,venmo_handle) select * from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[])`,
      [chunk.map((p) => p.name), chunk.map((p) => p.email), chunk.map(() => hash), chunk.map(() => 'alive'), chunk.map((p) => '5550100' + String(p.i).padStart(3, '0')), chunk.map((p) => '@sim' + p.i)])
  }
  const logins = await pmap(players, 6, async (p) => {
    const res = await http('POST', '/api/auth/login', { ip: p.ip, body: { email: p.email, password: p.password } })
    p.cookie = cookieFrom(res, 'survivor_session')
    return res.status
  })
  E(`all ${N} entries sign in over HTTP`, logins.every((s) => s === 200) && players.every((p) => p.cookie), `statuses ${[...new Set(logins)]}`)
  for (const r of await rows('select id, email from public.players')) players.find((p) => p.email === r.email).id = r.id
  E('registered count in the database', (await scalar('select count(*)::int from public.players')) === N)
}
const P = (p, method, path, body) => http(method, path, { cookie: p.cookie, body, ip: p.ip })

// ----------------------------------------------------------- pick helpers
const gameOfTeam = (day, abbr) => W.gamesOfDay(day).find((g) => g.home.abbr === abbr || g.away.abbr === abbr)
function choose(p, day, strength = 0.03) {
  const options = []
  for (const g of W.gamesOfDay(day)) for (const t of [g.home, g.away]) if (!p.used.has(t.abbr)) options.push([t, g])
  if (!options.length) return null
  const weights = options.map(([t]) => 1 + (17 - t.seed) * strength * 8)
  let r = W.rand() * weights.reduce((a, b) => a + b, 0)
  for (let k = 0; k < options.length; k++) { r -= weights[k]; if (r <= 0) return options[k][0] }
  return options[0][0]
}
const stats = { ok: 0, fail: {} }
async function submit(p, day, teamAbbr, extra = {}) {
  const res = await P(p, 'POST', '/api/picks', { slate_id: slateOfDay[day], team: teamAbbr, ...extra })
  if (res.status === 200) {
    stats.ok++
    const rec = res.json?.pick ?? {}
    p.picks = p.picks.filter((x) => x.id !== (extra.pick_id ?? '__'))
    p.picks.push({ id: rec.id ?? extra.pick_id, day, team: teamAbbr, updated_at: rec.updated_at, auto: false })
    if (extra.pick_id) { /* replaced */ }
    p.used = new Set(p.picks.map((x) => x.team))
  } else stats.fail[`${res.status} ${res.json?.error ?? ''}`.slice(0, 90)] = (stats.fail[`${res.status} ${res.json?.error ?? ''}`.slice(0, 90)] ?? 0) + 1
  return res
}

// ---- step 3: round one, day one, before the lock
ev.section('Step 3: round 1 day 1 picks before lock')
const groups = { none: players.slice(0, 100), one: players.slice(100, 550), two: players.slice(550) }
{
  const sample = await P(players[500], 'GET', '/api/me')
  ev.note(`/api/me sample keys: ${Object.keys(sample.json ?? {})}`)
  const t0 = performance.now()
  await pmap([...groups.one, ...groups.two], 8, async (p) => {
    for (let n = 0; n < (groups.two.includes(p) ? 2 : 1); n++) {
      const t = choose(p, 0); if (t) await submit(p, 0, t.abbr)
    }
  })
  ev.line(`submitted ${stats.ok} picks in ${((performance.now() - t0) / 1000).toFixed(0)}s; failures ${JSON.stringify(stats.fail)}`)
  const rowsDb = await rows(`select player_id, count(*)::int n from public.picks where slate_id=$1 group by 1`, [slateOfDay[0]])
  E('picks stored match accepted picks (no duplicates, no extras)', rowsDb.reduce((a, r) => a + r.n, 0) === players.reduce((a, p) => a + p.picks.length, 0), `${rowsDb.reduce((a, r) => a + r.n, 0)} rows vs ${players.reduce((a, p) => a + p.picks.length, 0)} accepted`)
  E('players with one pick: 1 row; two picks: 2 rows', rowsDb.every((r) => r.n <= 2) && rowsDb.length === 900, `${rowsDb.length} players with picks`)

  // changes: 200 players change one pick
  const changers = [...groups.one.slice(0, 100), ...groups.two.slice(0, 100)]
  const cres = await pmap(changers, 8, async (p) => {
    const old = p.picks[0]; const t = choose(p, 0)
    if (!t) return null
    return submit(p, 0, t.abbr, { pick_id: old.id, expected_version: old.updated_at })
  })
  E('200 pick changes before lock succeed', cres.filter((r) => r?.status === 200).length >= 195, `${cres.filter((r) => r?.status === 200).length}/200 ok; failures ${JSON.stringify(stats.fail)}`)
  const rowsAfter = await scalar(`select count(*)::int from public.picks where slate_id=$1`, [slateOfDay[0]])
  E('a change replaces the pick instead of adding one', rowsAfter === players.reduce((a, p) => a + p.picks.length, 0), `${rowsAfter} rows`)

  // quota and reuse rules
  const two = groups.two[150]
  const spare = choose(two, 0)
  const third = await P(two, 'POST', '/api/picks', { slate_id: slateOfDay[0], team: spare.abbr })
  E('a third pick in a two-pick round is refused (quota)', third.status === 409 || third.status === 400, `${third.status} ${third.json?.error}`)
  const reuse = await P(groups.one[200], 'POST', '/api/picks', { slate_id: slateOfDay[0], team: groups.one[200].picks[0].team })
  ev.note(`re-submitting the same team without request id: ${reuse.status} ${JSON.stringify(reuse.json).slice(0, 100)} (idempotent retry)`)
  const dupe = groups.two[160]
  const dres = await P(dupe, 'POST', '/api/picks', { slate_id: slateOfDay[0], team: dupe.picks[0].team, pick_id: dupe.picks[1].id, expected_version: dupe.picks[1].updated_at })
  E('team reuse is refused (changing the second pick to the first pick\'s team)', dres.status >= 400 && dres.status < 500, `${dres.status} ${dres.json?.error}`)
  const wrongTeam = await P(groups.one[201], 'POST', '/api/picks', { slate_id: slateOfDay[0], team: 'ZZZ' })
  E('a team not playing today is refused', wrongTeam.status === 400, `${wrongTeam.status} ${wrongTeam.json?.error}`)
  const nextDay = await P(groups.one[202], 'POST', '/api/picks', { slate_id: slateOfDay[1], team: choose(groups.one[202], 1).abbr })
  E('picking tomorrow before any result is refused', nextDay.status === 400, `${nextDay.status} ${nextDay.json?.error}`)

  // privacy before lock
  const viewer = groups.one[10], target = groups.two[10]
  const mine = target.picks.map((x) => x.team)
  const probe = async (label, cookie, ip) => {
    const outs = {}
    for (const path of ['/', '/api/sweat', '/api/live-scores', '/grid', '/api/grid/export', '/api/me', '/sweat', '/standings']) {
      const res = await http('GET', path, { cookie, ip, raw: true })
      outs[path] = res
    }
    return outs
  }
  const anon = await probe('anon', null, nextIp()), other = await probe('other', viewer.cookie, viewer.ip)
  const leaks = []
  for (const [who, outs] of Object.entries({ anon, other })) for (const [path, res] of Object.entries(outs)) {
    const body = res.text
    const idx = body.indexOf(target.name)
    // the entry's name may appear (standings); its team must not appear in a pick context
    if (target.id && path.startsWith('/api') && body.includes(target.id)) leaks.push(`${who} ${path}: contains the entry id`)
    if (idx >= 0) { const near = body.slice(Math.max(0, idx - 300), idx + 300); if (mine.some((t) => new RegExp(`\\b${t}\\b`).test(near))) leaks.push(`${who} ${path}: team near name`) }
  }
  E('before lock, no one else can see an entry\'s pick (home, sweat, live-scores, grid, export, me)', leaks.length === 0, leaks.slice(0, 3).join('; ') || `statuses ${Object.values(anon).map((r) => r.status)}`)
  const mePick = await P(target, 'GET', '/pick')
  E('own pick is visible to its owner (/pick)', mine.some((t) => mePick.text.includes(t)), `status ${mePick.status}`)
}

// ----------------------------------------------------------- shared checks
const winnerAbbr = (g) => (g.truth === 'home' ? g.home.abbr : g.away.abbr)
async function groundTruth(label) {
  const picks = await rows(`select p.player_id, p.team, p.slate_id, p.loss_excused from public.picks p`)
  const dayOf = Object.fromEntries(Object.entries(slateOfDay).map(([d, id]) => [id, Number(d)]))
  const byPlayer = new Map()
  for (const k of picks) { (byPlayer.get(k.player_id) ?? byPlayer.set(k.player_id, []).get(k.player_id)).push(k) }
  const expectedDead = new Set()
  for (const p of players) for (const k of byPlayer.get(p.id) ?? []) {
    const g = gameOfTeam(dayOf[k.slate_id], k.team)
    if (g?.settled && !g.void && winnerAbbr(g) !== k.team) expectedDead.add(p.id)
  }
  const dbDead = new Set((await rows(`select id from public.players where status='eliminated'`)).map((r) => r.id))
  const wrong = [...expectedDead].filter((x) => !dbDead.has(x)).length + [...dbDead].filter((x) => !expectedDead.has(x)).length
  E(`${label}: standings equal ground truth (alive ${N - expectedDead.size}, eliminated ${expectedDead.size})`, wrong === 0, `${wrong} mismatches`)
  for (const p of players) p.alive = !dbDead.has(p.id)
  return { alive: N - dbDead.size, dead: dbDead.size }
}
async function headerText() {
  const res = await http('GET', '/', { ip: nextIp(), raw: true })
  const m = res.text.match(/(\d+)<!-- --> <!-- -->registered|(\d+)<\/span><span[^>]*> alive of <!-- -->(\d+)|alive of/)
  const text = res.text.replace(/<!--.*?-->/g, '')
  const reg = text.match(/>(\d+)<\/span><span[^>]*> registered/), al = text.match(/>(\d+)<\/span><span[^>]*> alive of (\d+)/)
  return { reg: reg?.[1], alive: al?.[1], of: al?.[2], status: res.status }
}
const dbGame = async (g) => (await rows(`select id, result, result_source from public.games where espn_event_id=$1`, [g.espnId]))[0]
async function runWorkers(kinds, tag) {
  const out = []
  for (const k of kinds) {
    const r = await worker(k)
    out.push(`${k}:${r.claimed ? 'ran' : 'NOT-CLAIMED'}${r.ok ? '' : '!'}`)
    if (!r.claimed || r.status !== 200) E(`worker ${k} ran (${tag})`, false, JSON.stringify(r.body).slice(0, 200))
  }
  ev.line(`  workers ${tag}: ${out.join(' ')}`)
}
function finishFeed(g, outcome = g.truth, ot = false) { W.setFinal(g, outcome, ot); g.settled = true }

// ---- step 4: lock passes
ev.section('Step 4: lock passes')
await W.applyCalendar(0, 'locked')
await runWorkers(['schedule', 'grading'], 'after lock')
await mapSlates()
{
  const p = groups.two[20], pk = p.picks[0]
  const t = choose(p, 0)
  const res = await P(p, 'POST', '/api/picks', { slate_id: slateOfDay[0], team: t.abbr, pick_id: pk.id, expected_version: pk.updated_at })
  E('a pick change after lock is refused', res.status >= 400 && res.status < 500, `${res.status} ${res.json?.error}`)
  const fresh = await P(groups.none[3], 'POST', '/api/picks', { slate_id: slateOfDay[0], team: t.abbr })
  E('a first pick after lock is refused', fresh.status >= 400 && fresh.status < 500, `${fresh.status} ${fresh.json?.error}`)
  const before = await scalar('select count(*)::int from public.picks')
  const asg = await worker('assignment')
  const after = await scalar('select count(*)::int from public.picks')
  E('day-one lock does not assign (round stays open on day two)', asg.claimed && before === after, `${JSON.stringify(asg.progress).slice(0, 100)} picks ${before}->${after}`)
  // revealed
  const target = groups.two[10]
  const grid = await http('GET', '/grid', { ip: nextIp(), raw: true })
  const sweat = await http('GET', '/api/sweat', { ip: nextIp() })
  const shown = JSON.stringify(sweat.json).includes(target.picks[0].team) && JSON.stringify(sweat.json).includes(target.name)
  E('after lock picks are visible (grid shows the pick next to the entry)', grid.status === 200 && new RegExp(target.name + '[\\s\\S]{0,400}' + target.picks[0].team).test(grid.text.replace(/<[^>]+>/g, ' ')), `grid ${grid.status}, sweat shows pick: ${shown}`)
}

// ---- step 5: results arrive
ev.section('Step 5: results arrive (normal, overtime, postponed, corrected, flip)')
const d0 = W.gamesOfDay(0)
for (const g of d0) g.feed = 'in'
await W.applyCalendar(0, 'locked')
await runWorkers(['results'], 'games in progress')
E('nothing is graded while games are in progress', (await scalar(`select count(*)::int from public.players where status='eliminated'`)) === 0)
for (const g of d0) {
  const script = W.SCRIPT[g.key]
  if (script === 'postponed') { g.feed = 'postponed'; g.scoreHome = 0; g.scoreAway = 0 }
  else if (script === 'overtime') finishFeed(g, g.truth, true)
  else if (script === 'corrected') { W.setFinal(g, 'home'); g.reportedWrong = true } // wrong winner first
  else if (script === 'flip') { W.setFinal(g, 'home') }
  else if (script === 'manual') { W.setFinal(g, 'home') } // feed says the 5 seed wins
  else finishFeed(g)
}
d0.find((g) => W.SCRIPT[g.key] === 'flip').feed = 'final'
await W.applyCalendar(0, 'locked')
await runWorkers(['results', 'grading'], 'first finals')
const post = d0.find((g) => W.SCRIPT[g.key] === 'postponed')
{
  const rpost = await dbGame(post)
  E('postponed game (post, 0-0) stays pending', rpost.result === 'pending', rpost.result)
  const ot = d0.find((g) => W.SCRIPT[g.key] === 'overtime')
  E('overtime final graded', (await dbGame(ot)).result === (ot.truth === 'home' ? 'home_win' : 'away_win'))
}
// provisional ground truth: the wrong/flip/manual games are currently reported as home wins
const corr = d0.find((g) => W.SCRIPT[g.key] === 'corrected'), flip = d0.find((g) => W.SCRIPT[g.key] === 'flip'), manual = d0.find((g) => W.SCRIPT[g.key] === 'manual')
for (const g of [corr, flip, manual]) { g.settled = true; g.realTruth = g.truth; g.truth = 'home' }
await groundTruth('after first results (corrected/manual games temporarily home wins)')
// corrected A->B
corr.truth = corr.realTruth; W.setFinal(corr, corr.truth); await W.applyCalendar(0, 'locked')
await runWorkers(['results', 'grading'], 'correction')
E('corrected game result follows the feed to the right winner', (await dbGame(corr)).result === (corr.truth === 'home' ? 'home_win' : 'away_win'))
// flip A->B->A
flip.truth = 'away'; W.setFinal(flip, 'away'); await W.applyCalendar(0, 'locked'); await runWorkers(['results', 'grading'], 'flip to B')
flip.truth = flip.realTruth; W.setFinal(flip, flip.truth); await W.applyCalendar(0, 'locked'); await runWorkers(['results', 'grading'], 'flip back to A')
E('flipped game ends on its final result', (await dbGame(flip)).result === (flip.truth === 'home' ? 'home_win' : 'away_win'))
manual.truth = 'home' // until the organizer acts
await groundTruth('after correction and flip')

// ---- step 6: admin void and manual result
ev.section('Step 6: administrator void and manual result')
{
  const gid = (await dbGame(post)).id
  const noReason = await A('POST', '/api/results', { action: 'void', game_id: gid, reason: '' })
  E('void without a reason is refused', noReason.status === 400, `${noReason.status}`)
  const res = await A('POST', '/api/results', { action: 'void', game_id: gid, reason: 'Postponed; replayed outside the pool' })
  E('admin voids the postponed game with a reason', res.status === 200 && (await dbGame(post)).result === 'void', `${res.status} ${res.text.slice(0, 100)}`)
  post.settled = true; post.void = true
  const dead = await scalar(`select count(*)::int from public.players e join public.picks p on p.player_id=e.id where e.status='eliminated' and p.slate_id=$1 and p.team in ($2,$3) and not exists(select 1 from public.picks q where q.player_id=e.id and q.slate_id=$1 and q.team not in ($2,$3))`, [slateOfDay[0], post.home.abbr, post.away.abbr])
  E('a void never counts as a loss', dead === 0, `${dead} eliminated with only void picks`)
  const mid = (await dbGame(manual)).id
  const set = await A('POST', '/api/results', { action: 'set', game_id: mid, result: manual.realTruth === 'home' ? 'home_win' : 'away_win', reason: 'Organizer verified the score' })
  E('admin enters a manual result the feed disagrees with', set.status === 200, `${set.status} ${set.text.slice(0, 100)}`)
  manual.truth = manual.realTruth
  let held = true
  for (let i = 0; i < 20; i++) { const r = await cron('/api/cron/sync-results'); if (r.status !== 200) held = false; const g = await dbGame(manual); if (g.result !== (manual.truth === 'home' ? 'home_win' : 'away_win') || g.result_source !== 'admin') held = false }
  E('the manual result survives 20 result syncs', held)
  await runWorkers(['results', 'grading'], 'after admin actions')
  await groundTruth('after void and manual result')
  const h = await headerText()
  E('survivor header shows registered entries until round 1 is fully graded', h.reg === String(N) && !h.alive, JSON.stringify(h))
}

// ---- step 7: early pick for the next day
ev.section('Step 7: winners pick the next day early; losers cannot pick')
{
  const winner = groups.one.find((p) => p.alive && p.picks.length === 1)
  const loser = players.find((p) => !p.alive)
  const idle = groups.none.find((p) => p.alive)
  const t = choose(winner, 1)
  const early = await submit(winner, 1, t.abbr)
  E('a winner with a spare pick can pick the next day early', early.status === 200, `${early.status} ${early.json?.error ?? ''}`)
  const lt = choose(loser, 1)
  const lres = await P(loser, 'POST', '/api/picks', { slate_id: slateOfDay[1], team: lt.abbr })
  E('an eliminated entry cannot pick', lres.status === 403, `${lres.status} ${lres.json?.error}`)
  const lres0 = await P(loser, 'POST', '/api/picks', { slate_id: slateOfDay[0], team: lt.abbr })
  E('an eliminated entry cannot pick the locked day either', lres0.status >= 400, `${lres0.status}`)
  const ires = await submit(idle, 1, choose(idle, 1).abbr)
  E('an alive entry with no round-one pick cannot jump ahead of the active day', ires.status === 400, `${ires.status} ${ires.json?.error}`)
  const reuse = await P(winner, 'POST', '/api/picks', { slate_id: slateOfDay[1], team: winner.picks[0].team })
  E('re-using a team from an earlier day is refused', reuse.status === 400 || reuse.status === 409, `${reuse.status} ${reuse.json?.error}`)
  winner.picks = winner.picks.filter((x) => x.day === 0).concat(winner.picks.filter((x) => x.day === 1))
}
// turnover to day two
await W.applyCalendar(1, 'pre')
await runWorkers(['schedule', 'advance'], 'turnover to R1D2')
await mapSlates()
E('the scheduled turnover opens round one day two', (await rows(`select slate_date::text d from public.slates where is_active`))[0]?.d === W.sim.today, (await rows(`select slate_date::text d from public.slates where is_active`))[0]?.d)

// ---- round one day two: top-ups, lock, scheduled auto-assignment on the round's final day
ev.section('Step 4b: round 1 day 2, lock, auto-assignment of missed picks (final day of the round)')
{
  await P(players[0], 'GET', '/api/me')
  const topUp = players.filter((p) => p.alive && p.picks.length < 2 && p.i % 4 !== 0)
  await pmap(topUp, 8, async (p) => { const t = choose(p, 1); if (t) await submit(p, 1, t.abbr) })
  const dupTeam = players.find((p) => p.alive && p.picks.length === 2 && p.picks.every((k) => k.day === 0))
  const third = await P(dupTeam, 'POST', '/api/picks', { slate_id: slateOfDay[1], team: choose(dupTeam, 1).abbr })
  E('a third pick in the two-pick round is refused', third.status === 409, `${third.status} ${third.json?.error}`)
  const usedAgain = players.find((p) => p.alive && p.picks.length === 1)
  const again = await P(usedAgain, 'POST', '/api/picks', { slate_id: slateOfDay[1], team: usedAgain.picks[0].team })
  ev.note(`same team again (no request id) on day two: ${again.status} ${again.json?.error ?? 'accepted as retry/no-op'}`)
  await W.applyCalendar(1, 'locked')
  await runWorkers(['schedule', 'grading'], 'day two locked')
  const before = new Map((await rows(`select player_id, count(*)::int n from public.picks group by 1`)).map((r) => [r.player_id, r.n]))
  const needing = players.filter((p) => p.alive && (before.get(p.id) ?? 0) < 2)
  let a1 = await worker('assignment'), batches = 1
  while (!a1.progress?.done && batches < 15) { a1 = await worker('assignment'); batches++ }
  const afterPicks = await rows(`select p.player_id, p.team, p.seed, p.slate_id, p.auto_assigned from public.picks p`)
  const auto = afterPicks.filter((r) => r.auto_assigned)
  E('every alive entry short of the quota received exactly the missing picks', needing.every((p) => afterPicks.filter((r) => r.player_id === p.id).length === 2), `${needing.length} entries needed picks; ${auto.length} auto picks; ${batches} scheduler batches of at most 50 (done=${a1.progress?.done})`)
  const countAfter = afterPicks.length
  const a2 = await worker('assignment'); const a3 = await worker('assignment')
  E('re-running assignment adds nothing (exactly once)', (await scalar('select count(*)::int from public.picks')) === countAfter, `${a2.claimed}/${a3.claimed}`)
  // independent expectation: highest unused seed line, AP rank then name
  let wrong = 0, checked = 0
  const d2 = W.gamesOfDay(1)
  for (const p of needing.slice(0, 300)) {
    const mine = afterPicks.filter((r) => r.player_id === p.id)
    const prior = mine.filter((r) => !r.auto_assigned)
    const used = new Set(prior.map((r) => r.team)), seeds = new Set(prior.map((r) => r.seed).filter((x) => x))
    const expected = []
    for (let k = prior.length; k < 2; k++) {
      const cands = []
      for (const g of d2) for (const t of [g.home, g.away]) if (!used.has(t.abbr)) cands.push(t)
      const fresh = cands.filter((t) => !seeds.has(t.seed)); const poolC = fresh.length ? fresh : cands
      const best = Math.min(...poolC.map((t) => t.seed))
      const line = poolC.filter((t) => t.seed === best).sort((a, b) => (W.sim.rankings[a.abbr] ?? 1e9) - (W.sim.rankings[b.abbr] ?? 1e9) || a.abbr.localeCompare(b.abbr))
      expected.push(line[0].abbr); used.add(line[0].abbr); seeds.add(line[0].seed)
    }
    const got = mine.filter((r) => r.auto_assigned).map((r) => r.team).sort().join(',')
    checked++; if (got !== expected.sort().join(',')) wrong++
  }
  E('auto-assigned teams follow the highest-unused-seed rule (AP rank, then name)', wrong === 0 && checked > 0, `${checked} checked, ${wrong} differ`)
  const flagged = (await rows(`select count(*)::int n from public.picks where auto_assigned and seed is null`))[0].n
  ev.note(`auto picks without a stored seed: ${flagged}`)
}
ev.line(`TOTAL so far pass=${ev.pass} fail=${ev.fail} ${ev.failures.join(' | ')}`)
await closeSql()
