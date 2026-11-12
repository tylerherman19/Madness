import { NextRequest, NextResponse } from 'next/server'
import { withOperation } from '@/lib/operations'
import { centralClock, turnoverCaughtUp } from '@/lib/operationPolicy'
import { isAdvanceWindow } from '@/lib/advanceSchedule'
import { serverError } from '@/lib/alerts'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { advanceSlate } from '@/lib/advanceSlate'
import { logAudit } from '@/lib/audit'
import { getActiveDayStatus } from '@/lib/slateStatus'
import { validReason } from '@/lib/slateGuard'
export const maxDuration = 300
export async function GET(req: NextRequest) {
 const unauthorized = requireCron(req)
 if (unauthorized) return unauthorized
 const now = new Date()
 const db = await getDb()
 if (process.env.AUTOMATION_V2_ENABLED !== 'true' || !isAdvanceWindow(now)) return advanceSlate(db, now, 'system')
 try {
  const result = await withOperation(db, `turnover:${centralClock(now).date}`, async () => {
   const response = await advanceSlate(db, now, 'system')
   const body = await response.json()
   if (!response.ok) throw new Error('Turnover failed')
   return { done: turnoverCaughtUp(body, centralClock(now).date), value: body }
  })
  return NextResponse.json({ ok: true, ...result })
 } catch (error) { return serverError('api/cron/auto-advance', error) }
}
export async function POST(req: NextRequest) {
 const unauthorized = await requireAdmin()
 if (unauthorized) return unauthorized
 const body = await req.json().catch(() => null)
 const reason = validReason(body?.reason)
 if (!reason) return NextResponse.json({ error: 'Enter a reason (3 to 500 characters)' }, { status: 400 })
 const db = await getDb(), now = await getEffectiveNow()
 const before = await getActiveDayStatus(db, now).catch(() => null)
 await logAudit(db, {
  event_type: 'slate-advance-requested', actor: 'admin',
  message: `Admin requested advance from ${before?.slateDate ?? 'no active day'}`,
  details: { reason, from_slate_date: before?.slateDate ?? null, unpicked: before?.unpicked ?? null, pending_games: before?.pendingGames ?? null, ungraded_games: before?.ungradedGames ?? null, auto_assign_completed: before?.autoAssignCompleted ?? null },
 })
 return advanceSlate(db, now, 'admin')
}
