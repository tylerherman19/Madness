import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { supabase } from '@/lib/supabase'
import { centralClock, operationIsStale } from '@/lib/operationPolicy'
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
 const secret = process.env.MONITOR_SECRET
 const provided = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
 if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(secret), Buffer.from(provided))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 try {
  const { data, error } = await supabase.from('operation_runs').select('key,status,last_success_at,updated_at').order('updated_at', { ascending: false }).limit(200)
  if (error) throw error
  const now = new Date()
  const worker = (data ?? []).find(row => row.key.startsWith('worker:') && row.last_success_at)
  const clock = centralClock(now)
  const overdue = clock.hour === 3 && clock.minute >= 15 || clock.hour > 3
  const { data: slate, error: slateError } = await supabase.from('slates').select('slate_date').eq('is_active', true).maybeSingle()
  if (slateError) throw slateError
  const enabled = process.env.AUTOMATION_V2_ENABLED === 'true'
  const problems = [
   ...(enabled && operationIsStale(worker?.last_success_at ?? null, now, 10) ? ['worker-stale'] : []),
   ...(enabled && overdue && slate && slate.slate_date < clock.date ? ['turnover-overdue'] : []),

  ]
  const { count: failedJobs, error: jobError } = await supabase.from('operation_runs').select('key', {count:'exact',head:true}).eq('status','review')
  if (jobError) throw jobError
  if (enabled && failedJobs) problems.push('jobs-need-review')
  const { count, error: outboxError } = await supabase.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('status','review').gte('attempts',6)
  if (outboxError) throw outboxError
  if (process.env.OUTBOX_DELIVERY_ENABLED === 'true' && count) problems.push('notifications-need-review')
  return NextResponse.json({ ok: !problems.length, automationEnabled: enabled, problems, checkedAt: now.toISOString() }, { status: problems.length ? 503 : 200, headers: { 'Cache-Control': 'no-store' } })
 } catch { return NextResponse.json({ ok: false, problems: ['operations-schema-or-database-unavailable'] }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
}
