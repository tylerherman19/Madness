import { NextRequest } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { syncResults } from '@/lib/syncResults'
export const maxDuration = 300
export async function GET(req: NextRequest) {
 const unauthorized = requireCron(req)
 return unauthorized ?? syncResults(await getDb(), await getEffectiveNow())
}
export async function POST() {
 const unauthorized = await requireAdmin()
 return unauthorized ?? syncResults(await getDb(), await getEffectiveNow())
}
