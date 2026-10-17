import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { queueReminders } from '@/lib/reminders'
export const maxDuration = 300
export async function GET(req: NextRequest) {
 const unauthorized = requireCron(req)
 if (unauthorized) return unauthorized
 if (process.env.AUTOMATION_V2_ENABLED === 'true') return NextResponse.json({ok:true,message:'Deadline worker handles reminders'})
 return queueReminders(await getDb(), await getEffectiveNow(), undefined, getEffectiveNow)
}
export async function POST() {
 const unauthorized = await requireAdmin()
 if (unauthorized) return unauthorized
 if (process.env.AUTOMATION_V2_ENABLED === 'true') return NextResponse.json({ok:true,message:'Deadline worker handles reminders'})
 return queueReminders(await getDb(), await getEffectiveNow(), undefined, getEffectiveNow)
}
