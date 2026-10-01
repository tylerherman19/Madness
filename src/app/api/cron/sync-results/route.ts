import { NextRequest, NextResponse } from 'next/server'
import { getDb, isTestMode } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { settleOutstandingSlates, type SettleOutcome } from '@/lib/settle'

// Vercel Cron — refreshes results from ESPN and grades picks, no admin
// needed. Re-syncing is how results arrive: syncSlateFromEspn writes scores,
// status and result for every game on the day.
//
// It covers the active day and any earlier day that never finished grading
// (a failed or timed-out run on a previous night) — see lib/settle.ts.

// Grading awaits an elimination email per eliminated player (paced when
// email delivery is on), and a missed night adds a day or two of catch-up.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  if (unauthorized) return unauthorized
  return run()
}

// Admin-triggered run (the admin UI). POST rather than GET so a cross-site
// link can't fire it with the admin's cookie — see requireCron.
export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  return run()
}

function summarize(outcome: SettleOutcome) {
  return {
    date: outcome.slate_date,
    slate_number: outcome.slate_number,
    eliminated: outcome.grading?.eliminated ?? [],
    failed: outcome.grading?.failed.length ? outcome.grading.failed : undefined,
    settled: outcome.settled,
    sync_error: outcome.sync_error,
    error: outcome.error,
  }
}

async function run() {
  try {
    const supabase = await getDb()
    // Sandbox days hold made-up matchups; only the active one is pulled from
    // ESPN (as before), earlier ones are graded from their stored results.
    const report = await settleOutstandingSlates(supabase, { syncEarlierDays: !(await isTestMode()) })
    if (!report.active) return NextResponse.json({ ok: true, message: 'No active slate' })

    const activeId = report.active.id
    const active = report.outcomes.find((outcome) => outcome.slate_id === activeId) ?? null
    const caughtUp = report.outcomes.filter((outcome) => outcome.slate_id !== activeId)
    const failure = active?.error ?? active?.sync_error ?? caughtUp.find((outcome) => outcome.error)?.error

    const body = {
      ok: !failure,
      error: failure,
      message: active ? undefined : 'The active day is already fully graded',
      games_synced: active?.games_synced,
      partial: active?.partial,
      grading: active?.grading ?? null,
      catch_up: caughtUp.length > 0 ? caughtUp.map(summarize) : undefined,
      deferred: report.deferred > 0 ? report.deferred : undefined,
      tracking: report.tracking,
    }
    // A failed ESPN sync still grades from stored results, but the run is
    // reported as failed so the cron log and the admin both see it.
    return NextResponse.json(body, { status: failure ? 502 : 200 })
  } catch (err) {
    console.error('sync-results error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
