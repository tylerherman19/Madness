// Seeds a season into the local fixture database (tests/support/database.mjs)
// for the query-count script and the query-budget test. Rows go in with the
// fixture's seeding header, which skips row triggers like "pick period is not
// open"; nothing here can reach a hosted database.
export const ACTIVE = '00000000-0000-4000-8000-000000000001'
export const PLAYER = '00000000-0000-4000-8000-000000000002'
export const FUTURE_DAYS = 110

const post = async (DB, path, rows) => {
  const res = await fetch(`${DB}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-seed': '1' }, body: JSON.stringify(rows) })
  if (!res.ok) throw new Error(`seed ${path}: ${await res.text()}`)
}
const batched = async (DB, path, rows, size) => { for (let i = 0; i < rows.length; i += size) await post(DB, path, rows.slice(i, i + size)) }


// N entries (plus the fixture's two), D finished pick days before the active one,
// FUTURE_DAYS scheduled days after it. 10% of entries are eliminated along the way.
export async function seedSeason(DB, entries, days) {
  await fetch(`${DB}/__test/reset`, { method: 'POST' })
  const day = 86_400_000
  const base = Date.parse('2099-01-01T00:00:00Z')
  const slates = [], games = []
  for (let d = 1; d <= days; d++) {
    const id = crypto.randomUUID(), date = new Date(base - (days - d + 1) * day)
    slates.push({ id, slate_number: d, slate_date: date.toISOString().slice(0, 10), season_year: 2099, is_active: false, locks_at: new Date(date.getTime() + 18 * 3600e3).toISOString() })
    for (let g = 0; g < 4; g++) games.push({ slate_id: id, espn_event_id: `h${d}-${g}`, home_team: `W${d}_${g}`, away_team: `L${d}_${g}`, tip_time: new Date(date.getTime() + 18 * 3600e3).toISOString(), result: 'home_win', status_state: 'post' })
    slates[slates.length - 1].__id = id
  }
  for (let f = 1; f <= FUTURE_DAYS; f++) {
    const id = crypto.randomUUID(), date = new Date(base + f * day)
    slates.push({ id, slate_number: days + 1 + f, slate_date: date.toISOString().slice(0, 10), season_year: 2099, is_active: false, locks_at: new Date(date.getTime() + 18 * 3600e3).toISOString() })
    games.push({ slate_id: id, espn_event_id: `f${f}`, home_team: `FA${f}`, away_team: `FB${f}`, tip_time: new Date(date.getTime() + 18 * 3600e3).toISOString(), result: 'pending', status_state: 'pre' })
  }
  await fetch(`${DB}/slates?id=eq.${ACTIVE}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slate_number: days + 1 }) })
  const past = slates.filter((s) => s.__id)
  for (const s of slates) delete s.__id
  await batched(DB, '/slates', slates, 200)
  await batched(DB, '/games', games, 500)

  const players = [], picks = [], out = []
  for (let i = 0; i < entries; i++) {
    const id = crypto.randomUUID()
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
  await batched(DB, '/players', players, 500)
  await batched(DB, '/picks', picks, 2000)
  // A database trigger refuses picks from eliminated entries, so they are marked out afterwards.
  const bySlate = new Map()
  for (const [id, n] of out) bySlate.set(n, [...(bySlate.get(n) ?? []), id])
  for (const [n, ids] of bySlate) for (let i = 0; i < ids.length; i += 50) {
    const res = await fetch(`${DB}/players?id=in.(${ids.slice(i, i + 50).join(',')})`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-fixture-seed': '1' }, body: JSON.stringify({ status: 'eliminated', elimination_slate: n, elimination_reason: 'Lost' }) })
    if (!res.ok) throw new Error('eliminate: ' + (await res.text()))
  }
  // The fixture's own signed-in player gets a past pick on every day too.
  const own = past.map((s, d) => ({ player_id: PLAYER, slate_id: s.id, team: `W${d + 1}_9`, seed: 3 }))
  await batched(DB, '/picks', own, 1000)
  return picks.length + own.length
}

