import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { runAutoAssignNow } from '@/lib/autoAssign'
import { serverError } from '@/lib/alerts'

// Per-player DB round trips plus awaited emails — allow a big no-pick cohort.
export const maxDuration = 300

// Backstop only. Auto-assign normally fires within minutes of the day's first
// tip via autoAssignIfDue() (see lib/autoAssign.ts); this daily Vercel Cron
// catches a day nobody visited the site. Re-running is harmless.
//
// GET is Vercel Cron's method and accepts only the cron secret. Admins trigger
// a run with POST, which a cross-site link or image can't forge with the admin
// cookie attached (the cookie is SameSite=Lax).
export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  if (unauthorized) return unauthorized
  return run()
}

export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  return run()
}

async function run() {
  try {
    const outcome = await runAutoAssignNow(await getDb(), await getEffectiveNow())
    return NextResponse.json({ ok: outcome.ok, message: outcome.message, results: outcome.results })
  } catch (err) {
    return serverError('api/cron/auto-assign', err)
  }
}
