import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAdmin, requireCron } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { FAILURE_EVENTS } from '@/lib/auditEvents'
import { sendAlertText, serverError } from '@/lib/alerts'
import { getDb } from '@/lib/testMode'

// Morning text: the last 24 hours of pool activity plus any failures. It
// arrives even on a quiet day, so a missing summary is itself a signal that
// the crons (or email) stopped working.
const WINDOW_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  if (unauthorized) return unauthorized
  return run(await getDb(), 'system')
}

// Admin "send now" from the audit page. POST for the same reason as the
// other cron routes — see requireCron.
export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  return run(await getDb(), 'admin')
}

async function countEvents(db: SupabaseClient, since: string, types: string[]): Promise<number> {
  const { count } = await db
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .in('event_type', types)
    .gte('created_at', since)
  return count ?? 0
}

async function run(db: SupabaseClient, actor: 'system' | 'admin') {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString()
    const failureTypes = [...FAILURE_EVENTS]

    const [picks, changed, auto, out, signups, failures, failureRows, alive] = await Promise.all([
      countEvents(db, since, ['pick-submitted']),
      countEvents(db, since, ['pick-changed']),
      countEvents(db, since, ['pick-auto-assigned']),
      countEvents(db, since, ['player-eliminated']),
      countEvents(db, since, ['player-signed-up']),
      countEvents(db, since, failureTypes),
      db
        .from('audit_log')
        .select('details')
        .in('event_type', failureTypes)
        .gte('created_at', since)
        .limit(200),
      db.from('players').select('id', { count: 'exact', head: true }).eq('status', 'alive'),
    ])

    const sources = [
      ...new Set(
        ((failureRows.data || []) as { details: { source?: string } | null }[])
          .map((r) => r.details?.source?.replace(/^api\/(cron\/)?/, ''))
          .filter((s): s is string => !!s)
      ),
    ]

    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric' }).format(new Date())
    const activity = [
      `${picks} picks`,
      changed && `${changed} changed`,
      auto && `${auto} auto`,
      out && `${out} out`,
      signups && `${signups} signup${signups === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ')
    const failureText = failures === 0 ? 'No failures.' : `FAILURES: ${failures} (${sources.slice(0, 3).join(', ')})`
    const text = `Madness ${date}: ${activity}. ${alive.count ?? 0} alive. ${failureText}`

    const delivery = await sendAlertText(text)
    await logAudit(db, {
      event_type: 'daily-summary',
      actor,
      message: text,
      details: { picks, changed, auto, eliminated: out, signups, failures, failure_sources: sources, delivery },
    })

    return NextResponse.json({ ok: true, text, delivery })
  } catch (err) {
    return serverError('api/cron/daily-summary', err)
  }
}
