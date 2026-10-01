import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { getPoolConfig, updatePoolConfig, type PoolConfigPatch } from '@/lib/pool'
import {
  AUTO_PICK_BEHAVIORS,
  COMPETITION_MODES,
  POOL_STATUSES,
  MODE_LABEL,
  SUPPORTED_DEADLINE_RULES,
  SUPPORTED_PICK_FREQUENCIES,
  SUPPORTED_REUSE_RULES,
  TIEBREAKERS,
  type CompetitionMode,
  type PoolStatus,
} from '@/lib/competition'

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

    // Only rules the engine enforces are accepted. The table allows more
    // (see SUPPORTED_* in lib/competition.ts), but storing one the engine
    // ignores would only make the pool describe rules it doesn't run.
    // starts_on is no longer offered: nothing reads it.
    const enums: [keyof PoolConfigPatch, string, readonly string[]][] = [
      ['competition_mode', 'competition_mode', COMPETITION_MODES],
      ['status', 'status', POOL_STATUSES],
      ['pick_frequency', 'pick_frequency', SUPPORTED_PICK_FREQUENCIES],
      ['pick_deadline_rule', 'pick_deadline_rule', SUPPORTED_DEADLINE_RULES],
      ['team_reuse_rule', 'team_reuse_rule', SUPPORTED_REUSE_RULES],
      ['auto_pick_behavior', 'auto_pick_behavior', AUTO_PICK_BEHAVIORS],
      ['tiebreaker', 'tiebreaker', TIEBREAKERS],
    ]
    for (const [field, key, allowed] of enums) {
      const value = pickEnum(body, key, allowed)
      if (value === null) {
        return NextResponse.json({ error: `Invalid or unsupported ${key}` }, { status: 400 })
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
