import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import { logAudit } from '@/lib/audit'
export async function POST(req: NextRequest) {
 const unauthorized=await requireAdmin()
 if (unauthorized) return unauthorized
 const body=await req.json().catch(()=>null)
 if (!body || !['retry-job','retry-notification','retention-preview','retention-apply'].includes(body.action)) return NextResponse.json({error:'Invalid action'},{status:400})
 const db=await getDb()
 try {
  if (body.action.startsWith('retention-')) {
   if (body.action==='retention-apply' && body.confirmation!=='CLEAN EXPIRED OPERATIONS') return NextResponse.json({error:'Confirmation required'},{status:400})
   const {data,error}=await db.rpc('operation_retention',{p_apply:body.action==='retention-apply'})
   if(error) throw error
   return NextResponse.json({ok:true,result:data})
  }
  if(typeof body.id!=='string' || !body.id || body.id.length>250 || typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>500) return NextResponse.json({error:'Choose a failed item and provide a reason'},{status:400})
  // Only review items can be retried, never sent/done items or an active lease.
  const table=body.action==='retry-job'?'operation_runs':'notification_outbox'
  const updates=body.action==='retry-job'?{status:'pending',attempts:0,token:null,lease_until:null,next_attempt_at:new Date().toISOString()}:{status:'pending',attempts:0,lease_token:null,lease_until:null,next_attempt_at:new Date().toISOString()}
  let query=db.from(table).update(updates).eq(body.action==='retry-job'?'key':'id',body.id).eq('status','review').is('lease_until',null)
  if(body.action==='retry-notification')query=query.gte('created_at',new Date(Date.now()-23*60*60*1000).toISOString())
  const {data,error}=await query.select(body.action==='retry-job'?'key':'id').maybeSingle()
  if(error) throw error
  if(!data) return NextResponse.json({error:'Item is not awaiting review or its safe retry window expired'},{status:409})
  await logAudit(db,{event_type:'operation-retried',actor:'admin',message:'Organizer retried a reviewed operation',details:{action:body.action,id:body.id,reason:body.reason.trim()}})
  return NextResponse.json({ok:true})
 } catch { return NextResponse.json({error:'Operations unavailable. Verify the operations migration.'},{status:503}) }
}
