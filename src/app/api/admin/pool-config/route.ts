import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { getPoolConfig, updatePoolConfig, type PoolConfigPatch } from '@/lib/pool'
import {
  COMPETITION_MODES,
  POOL_STATUSES,
  MODE_LABEL,
  type CompetitionMode,
  type PoolStatus,
} from '@/lib/competition'

const PICK_FREQUENCIES = ['every-game-day', 'weekends-only', 'tournament-round']
const DEADLINE_RULES = ['first-tip', 'per-game']
const REUSE_RULES = ['once-per-pool', 'once-per-round', 'unlimited']
const AUTO_PICK = ['latest-game', 'eliminate', 'none']
const TIEBREAKERS = ['seed-total', 'most-survived', 'none']

// Read one enum field off the request body, rejecting anything not in the
// allowed set rather than trusting the client's string into a checked column.
function pickEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): T | undefined | null {
  if (!(key in body)) return undefined
  const value = body[key]
  if (typeof value !== 'string' || !allowed.includes(value)) return null
  return value as T
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = (await req.json()) as Record<string, unknown>
    const supabase = await getDb()

    const current = await getPoolConfig(supabase)
    const poolId = typeof body.pool_id === 'string' && isUuid(body.pool_id) ? body.pool_id : current.id
    if (!poolId) {
      return NextResponse.json(
        {
          error:
            'No pool row to configure. Apply supabase/migrations/017_pool_configuration.sql, then reload.',
        },
        { status: 409 }
      )
    }

    const patch: PoolConfigPatch = {}

    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name || name.length > 80) {
        return NextResponse.json({ error: 'Pool name must be 1–80 characters' }, { status: 400 })
      }
      patch.name = name
    }

    if (body.season_year !== undefined) {
      const year = Number(body.season_year)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return NextResponse.json({ error: 'Season must be a four-digit year' }, { status: 400 })
      }
      patch.season_year = year
    }

    if (body.starts_on !== undefined) {
      const raw = body.starts_on
      if (raw === null || raw === '') {
        patch.starts_on = null
      } else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        patch.starts_on = raw
      } else {
        return NextResponse.json({ error: 'Start date must be YYYY-MM-DD' }, { status: 400 })
      }
    }

    const enums: [keyof PoolConfigPatch, string, readonly string[]][] = [
      ['competition_mode', 'competition_mode', COMPETITION_MODES],
      ['status', 'status', POOL_STATUSES],
      ['pick_frequency', 'pick_frequency', PICK_FREQUENCIES],
      ['pick_deadline_rule', 'pick_deadline_rule', DEADLINE_RULES],
      ['team_reuse_rule', 'team_reuse_rule', REUSE_RULES],
      ['auto_pick_behavior', 'auto_pick_behavior', AUTO_PICK],
      ['tiebreaker', 'tiebreaker', TIEBREAKERS],
    ]
    for (const [field, key, allowed] of enums) {
      const value = pickEnum(body, key, allowed)
      if (value === null) {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      }
      if (value !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(patch as any)[field] = value
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const result = await updatePoolConfig(supabase, poolId, patch)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // A mode change is the one edit worth calling out in the trail: it
    // reorganises how every existing pick and elimination is presented.
    const modeChanged =
      patch.competition_mode !== undefined && patch.competition_mode !== current.competition_mode
    await logAudit(supabase, {
      event_type: 'pool-config-updated',
      actor: 'admin',
      message: modeChanged
        ? `Admin switched competition format from ${MODE_LABEL[current.competition_mode as CompetitionMode]} to ${MODE_LABEL[patch.competition_mode as CompetitionMode]}`
        : `Admin updated pool configuration (${Object.keys(patch).join(', ')})`,
      details: { pool_id: poolId, changed: patch, previous_mode: current.competition_mode },
    })

    // The mode reaches the cached marketing-side pages, so bust them all.
    for (const path of ['/', '/grid', '/schedule', '/live', '/pick', '/history']) {
      revalidatePath(path)
    }

    return NextResponse.json({ ok: true, pool: result.pool, mode_changed: modeChanged })
  } catch (err) {
    console.error('pool-config error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// Reading the config back is useful for the admin form's optimistic refresh.
export async function GET() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  const pool = await getPoolConfig()
  return NextResponse.json({ pool } satisfies { pool: Awaited<ReturnType<typeof getPoolConfig>> })
}

export type PoolStatusExport = PoolStatus
