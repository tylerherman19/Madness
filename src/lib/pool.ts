import 'server-only'
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
  name: 'MADNESS',
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

// The active pool, or the regular-season default when none is configured.
export async function getPoolConfig(db?: SupabaseClient): Promise<PoolConfig> {
  try {
    const supabase = db ?? (await getDb())
    const { data, error } = await supabase
      .from('pools')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()
    if (error || !data) return DEFAULT_POOL_CONFIG
    return normalize(data)
  } catch {
    // Table missing (migration not applied) or the database is unreachable —
    // the pages that call this must still render.
    return DEFAULT_POOL_CONFIG
  }
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
