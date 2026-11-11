import 'server-only'
import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getDb } from './testMode'
import {
  COMPETITION_MODES,
  POOL_STATUSES,
  type CompetitionMode,
  type PoolConfig,
  type PoolStatus,
} from './competition'

// Reading and writing the active pool's configuration.
//
// Every mode-dependent decision in the app funnels through getPoolConfig().
// The mode is a stored administrator choice — never the calendar month, never
// an environment variable.

// What the app falls back to when there is no pools row to read: either the
// 017 migration hasn't been applied yet, or the table is empty. A
// regular-season pool is the safe default — it shows strictly less (no seeds,
// no rounds, no bracket context), so a misread can never invent tournament
// data that isn't there.
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  id: '',
  name: 'Pick and Pray',
  competition_mode: 'regular-season',
  status: 'live',
  season_year: new Date().getFullYear(),
  pick_frequency: 'every-game-day',
  pick_deadline_rule: 'first-tip',
  team_reuse_rule: 'once-per-pool',
  auto_pick_behavior: 'latest-game',
  tiebreaker: 'seed-total',
  starts_on: null,
  is_active: true,
}

// Coerce a database row into a PoolConfig, refusing values the enums don't
// cover rather than letting an unexpected string reach the capability lookup.
function normalize(row: Record<string, unknown>): PoolConfig {
  const mode = row.competition_mode as CompetitionMode
  const status = row.status as PoolStatus
  return {
    ...DEFAULT_POOL_CONFIG,
    ...row,
    competition_mode: COMPETITION_MODES.includes(mode) ? mode : 'regular-season',
    status: POOL_STATUSES.includes(status) ? status : 'live',
  } as PoolConfig
}

// One read of the active pool row per render, however many components ask.
// (Outside a render, such as in a Route Handler, React's cache does not
// memoize and every call reads fresh.)
const readActivePool = cache(async (supabase: SupabaseClient) =>
  supabase.from('pools').select('*').eq('is_active', true).maybeSingle()
)

// The active pool, or the regular-season default when none is configured.
export async function getPoolConfig(db?: SupabaseClient, strict = false): Promise<PoolConfig> {
  try {
    const supabase = db ?? (await getDb())
    const { data, error } = await readActivePool(supabase)
    if (error || !data) {
      if (strict) throw new Error('Competition rules are unavailable. Please contact support.')
      return DEFAULT_POOL_CONFIG
    }
    return normalize(data)
  } catch (error) {
    if (strict) throw error
    // Table missing (migration not applied) or the database is unreachable —
    // the pages that call this must still render.
    return DEFAULT_POOL_CONFIG
  }
}

// For loaders whose result is cached and shared: a database error throws, so
// a momentary outage is never stored as the regular-season default. A pool
// table with no active row is a real state and does fall back to the default.
export async function readPoolConfig(db: SupabaseClient): Promise<PoolConfig> {
  const { data, error } = await readActivePool(db)
  if (error) throw error
  return data ? normalize(data) : DEFAULT_POOL_CONFIG
}

// Contest scope for live-gameplay queries on `players` and `picks` (migration
// 030: an entry belongs to exactly one contest; an archived contest's entries
// must never appear in the current one).
//
// A scope is the active pool's id, or null when the schema predates 030 (the
// pool row has no `ended_on`, which 030 adds in the same transaction as
// players.pool_id); then every entry is the one contest's and no filter is
// applied, so the app keeps working until the migration lands. Everything else
// fails closed: a read error throws, and the no-row default (id '') scopes to
// an id no entry has, never to every contest.
export const NO_POOL_ID = '00000000-0000-0000-0000-000000000000'
export function contestScopeOf(pool: { id?: string | null }): string | null {
  if (!pool.id) return NO_POOL_ID
  return 'ended_on' in pool ? pool.id : null
}
export const poolScope = (pool: { id?: string | null }): string | null => contestScopeOf(pool)

// Filter argument for `.match(...)`: the contest condition, or none on a pre-030 schema.
export const contestFilter = (scope: string | null): Record<string, string> => (scope ? { pool_id: scope } : {})

// The active contest's scope, read live. Throws when no active contest can be read.
export async function getActivePoolId(db?: SupabaseClient): Promise<string | null> {
  const supabase = db ?? (await getDb())
  const { data, error } = await readActivePool(supabase)
  if (error) throw error
  if (!data?.id) throw new Error('No active contest is configured')
  return contestScopeOf(data)
}

export type PoolConfigPatch = Partial<
  Pick<
    PoolConfig,
    | 'name'
    | 'competition_mode'
    | 'status'
    | 'season_year'
    | 'pick_frequency'
    | 'pick_deadline_rule'
    | 'team_reuse_rule'
    | 'auto_pick_behavior'
    | 'tiebreaker'
    | 'starts_on'
  >
>

// Update the active pool. Configuration only — this never touches players,
// picks, slates or results. Changing competition mode reorganises how the
// same survivor history is displayed; it does not rewrite or delete any of it.
export async function updatePoolConfig(
  db: SupabaseClient,
  poolId: string,
  patch: PoolConfigPatch
): Promise<{ pool: PoolConfig } | { error: string }> {
  const { data, error } = await db
    .from('pools')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', poolId)
    .select('*')
    .single()

  if (error || !data) {
    return { error: error?.message ?? 'Pool not found' }
  }
  return { pool: normalize(data) }
}
