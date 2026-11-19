import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ELITE_2027_SATURDAY, ELITE_2027_SUNDAY, MARCH_2027_START } from './march2027'

// Test Mode only: a sandbox copy of the 2027 Elite Eight weekend, so the
// two-pick rule can be rehearsed end to end (submit both, lock, auto-assign,
// grade both days) before the real tournament. Never call it with the
// production client.
//
// What it builds:
//   - an active 2027 March Madness pool with the published rules
//   - Saturday 3/27 and Sunday 3/28 with two Elite Eight games each
//     (Saturday is the active day; both picks lock at its first tip)
//   - `players` test entries, all alive
//   - the sandbox clock two hours before Saturday's first tip

export const ELITE_REHEARSAL_POOL = '7e57e118-0000-4000-8000-000000002027'
const SATURDAY = '7e57e118-0000-4000-8000-000000000327'
const SUNDAY = '7e57e118-0000-4000-8000-000000000328'
// Shared by both day ids above.
const REHEARSAL_DAY_PREFIX = '7e57e118-0000-4000-8000-00000000032'

// Seeds are the bracket's 1–16 lines. Tip times are Central-date correct:
// 00:49Z on 3/28 is still Saturday evening in Chicago.
export const ELITE_REHEARSAL_GAMES = [
  { slate: SATURDAY, id: 'rehearsal-e8-1', away: 'CONN', away_id: 'r-41', away_seed: 1, home: 'HOU', home_id: 'r-248', home_seed: 3, tip: '2027-03-27T22:09:00Z', region: 'East' },
  { slate: SATURDAY, id: 'rehearsal-e8-2', away: 'ARIZ', away_id: 'r-12', away_seed: 2, home: 'GONZ', home_id: 'r-2250', home_seed: 4, tip: '2027-03-28T00:49:00Z', region: 'West' },
  { slate: SUNDAY, id: 'rehearsal-e8-3', away: 'DUKE', away_id: 'r-150', away_seed: 1, home: 'KU', home_id: 'r-2305', home_seed: 6, tip: '2027-03-28T18:20:00Z', region: 'South' },
  { slate: SUNDAY, id: 'rehearsal-e8-4', away: 'PUR', away_id: 'r-2509', away_seed: 2, home: 'AUB', home_id: 'r-2', home_seed: 5, tip: '2027-03-28T20:50:00Z', region: 'Midwest' },
] as const

export const ELITE_REHEARSAL_LOCK = ELITE_REHEARSAL_GAMES[0].tip
export const ELITE_REHEARSAL_START = '2027-03-27T20:09:00Z'

function must<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`)
  return result.data
}

// Back to ordinary Test Mode after a rehearsal: the 2027 rehearsal pool is
// switched off and the newest other sandbox pool becomes active again, so
// "Seed Test Slate + Users" is not refused by the 2027 registration rule.
export async function leaveEliteRehearsal(db: SupabaseClient) {
  const { data: active, error } = await db.from('pools').select('id').eq('is_active', true).maybeSingle()
  if (error) throw new Error(`Read sandbox pool: ${error.message}`)
  if (active?.id !== ELITE_REHEARSAL_POOL) return false
  must(await db.from('slates').update({ is_active: false }).eq('is_active', true), 'Deactivate sandbox day')
  must(await db.from('pools').update({ is_active: false }).eq('id', ELITE_REHEARSAL_POOL), 'Leave rehearsal pool')
  const { data: previous, error: previousError } = await db.from('pools').select('id')
    .neq('id', ELITE_REHEARSAL_POOL).order('created_at', { ascending: false }).limit(1)
  if (previousError) throw new Error(`Find previous sandbox pool: ${previousError.message}`)
  if (previous?.[0]) must(await db.from('pools').update({ is_active: true }).eq('id', previous[0].id), 'Restore previous sandbox pool')
  return true
}

export async function seedEliteEightRehearsal(db: SupabaseClient, players: number, passwordHash: string) {
  const count = Math.min(Math.max(Math.trunc(players), 1), 30)

  // 1. Nothing active while the sandbox is cleared. With no active pool the
  //    2027 registration window does not apply to the test entries below.
  must(await db.from('slates').update({ is_active: false }).eq('is_active', true), 'Deactivate sandbox day')
  must(await db.from('pools').update({ is_active: false }).eq('is_active', true), 'Deactivate sandbox pool')
  for (const table of ['picks', 'games', 'slates', 'players'] as const) {
    must(await db.from(table).delete().not('id', 'is', null), `Clear sandbox ${table}`)
  }
  must(await db.from('clock').update({ simulated_now: null }).eq('id', true), 'Reset sandbox clock')
  // The rehearsal reuses the same day ids, so a previous run's finished
  // operations (the durable auto-assign claim for Saturday, reminders) would
  // make the next rehearsal skip them. Clear only this weekend's keys.
  const stale = await db.from('operation_runs').delete().ilike('key', `%${REHEARSAL_DAY_PREFIX}%`)
  // A database without the operations migration has no such table.
  if (stale.error && !['PGRST205', '42P01'].includes(stale.error.code ?? '')) {
    throw new Error(`Clear sandbox operations: ${stale.error.message}`)
  }

  // 2. Test entries.
  const entries = Array.from({ length: count }, (_, i) => ({
    full_name: `Elite Tester ${i + 1}`,
    email: `test.elite${i + 1}@nflsurvivor.internal`,
    pin_hash: passwordHash,
    paid: true,
    status: 'alive',
  }))
  must(await db.from('players').insert(entries), 'Create test entries')

  // 3. The weekend.
  must(await db.from('slates').insert([
    { id: SATURDAY, slate_number: 27, slate_date: ELITE_2027_SATURDAY, season_year: 2027, is_active: false, locks_at: ELITE_REHEARSAL_LOCK },
    { id: SUNDAY, slate_number: 28, slate_date: ELITE_2027_SUNDAY, season_year: 2027, is_active: false, locks_at: ELITE_REHEARSAL_GAMES[2].tip },
  ]), 'Create Elite Eight days')
  must(await db.from('games').insert(ELITE_REHEARSAL_GAMES.map((g) => ({
    slate_id: g.slate, espn_event_id: g.id,
    home_team: g.home, away_team: g.away, home_team_id: g.home_id, away_team_id: g.away_id,
    home_seed: g.home_seed, away_seed: g.away_seed,
    round_label: 'Elite 8', region: g.region, tip_time: g.tip,
    status_state: 'pre', result: 'pending',
  }))), 'Create Elite Eight games')

  // 4. The 2027 pool with the published rules (the database refuses any other).
  const { data: existing } = await db.from('pools').select('id').eq('id', ELITE_REHEARSAL_POOL).maybeSingle()
  const pool = {
    name: 'Elite Eight rehearsal', competition_mode: 'march-madness', status: 'live', season_year: 2027,
    starts_on: MARCH_2027_START, pick_frequency: 'every-game-day', pick_deadline_rule: 'first-tip',
    team_reuse_rule: 'once-per-pool', auto_pick_behavior: 'highest-seed', tiebreaker: 'seed-total', is_active: true,
  }
  if (existing) must(await db.from('pools').update(pool).eq('id', ELITE_REHEARSAL_POOL), 'Activate rehearsal pool')
  else must(await db.from('pools').insert({ id: ELITE_REHEARSAL_POOL, ...pool }), 'Create rehearsal pool')

  // 5. Saturday is the active day; clock two hours before its first tip.
  must(await db.from('slates').update({ is_active: true }).eq('id', SATURDAY), 'Open Saturday')
  must(await db.from('clock').update({ simulated_now: ELITE_REHEARSAL_START }).eq('id', true), 'Set sandbox clock')

  return { entries: count, lock: ELITE_REHEARSAL_LOCK, clock: ELITE_REHEARSAL_START, games: ELITE_REHEARSAL_GAMES.length }
}
