import { NextRequest, NextResponse } from 'next/server'
import { withOperation } from '@/lib/operations'
import { centralClock, turnoverCaughtUp } from '@/lib/operationPolicy'
import { isAdvanceWindow } from '@/lib/advanceSchedule'
import { serverError } from '@/lib/alerts'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { advanceSlate } from '@/lib/advanceSlate'
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
export async function POST() {
 const unauthorized = await requireAdmin()
 return unauthorized ?? advanceSlate(await getDb(), await getEffectiveNow(), 'admin')
}
