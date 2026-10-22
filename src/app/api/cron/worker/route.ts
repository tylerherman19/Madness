import { NextRequest, NextResponse } from 'next/server'
import { requireCron } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { runAutoAssignNow } from '@/lib/autoAssign'
import { syncResults } from '@/lib/syncResults'
import { advanceSlate } from '@/lib/advanceSlate'
import { queueReminders } from '@/lib/reminders'
import { deliverNotifications } from '@/lib/notificationWorker'
import { withOperation } from '@/lib/operations'
import { centralClock, reminderWindow, turnoverCaughtUp } from '@/lib/operationPolicy'
import { runTournamentJob,WORKLOADS,type Workload } from '@/lib/tournamentJobs'
import { serverError } from '@/lib/alerts'
export const maxDuration = 300
export async function GET(req: NextRequest) {
 const unauthorized = requireCron(req)
 if (unauthorized) return unauthorized
 if (process.env.AUTOMATION_V2_ENABLED !== 'true') return NextResponse.json({ ok: true, enabled: false })
 if(process.env.TOURNAMENT_RELIABILITY_ENABLED==='true') {
  const kind=req.nextUrl.searchParams.get('workload') as Workload|null
  if(!kind||!WORKLOADS.includes(kind))return NextResponse.json({error:'Choose a workload'},{status:400})
  try {return NextResponse.json({ok:true,...await runTournamentJob(supabase,kind)})}
  catch(error){return serverError(`api/cron/worker/${kind}`,error,'This workload is delayed. Saved picks are unaffected; another attempt is scheduled.')}
 }
 const now = new Date()
 const clock = centralClock(now)
 const slot = Math.floor(now.getTime() / 60_000)
 try {
  const result = await withOperation(supabase, `worker:${slot}`, async () => {
   if (slot % 5 === 0) {
    const response = await syncResults(supabase, now)
    if (!response.ok) throw new Error('Result sync failed')
   }
   const assignment = await runAutoAssignNow(supabase, now)
   if (!assignment.ok) throw new Error('Assignment batch failed')
   if (clock.hour >= 3) {
    await withOperation(supabase, `turnover:${clock.date}`, async () => {
     const response = await advanceSlate(supabase, now, 'system')
     const body = await response.json()
     if (!response.ok) throw new Error('Turnover failed')
     return { done: turnoverCaughtUp(body, clock.date), value: body }
    })
   }
   const { data: slate, error } = await supabase.from('slates').select('id,locks_at').eq('is_active', true).maybeSingle()
   if (error) throw error
   const window = slate?.locks_at ? reminderWindow(new Date(slate.locks_at), now) : null
   if (window) await withOperation(supabase, `reminder:${slate!.id}:${window}`, async () => {
    const response = await queueReminders(supabase, now, window)
    if (!response.ok) throw new Error('Reminder queue failed')
    return { done: true, value: null }
   })
   await withOperation(supabase, `retention:${clock.date}`, async () => {
    const { error } = await supabase.rpc('operation_retention', { p_apply: true })
    if (error) throw error
    return { done: true, value: null }
   })
   const delivery = await deliverNotifications(supabase)
   return { done: true, value: { assignmentComplete: assignment.done, delivery } }
  })
  return NextResponse.json({ ok: true, ...result })
 } catch (error) { return serverError('api/cron/worker', error, 'Background work failed; it will retry') }
}
