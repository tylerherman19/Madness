import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin } from '@/lib/api'
import {adminSessionId} from '@/lib/session'
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
  if(body.action==='retry-notification'){
   const result=await db.rpc('retry_notification',{p_id:body.id,p_actor:await adminSessionId(),p_reason:body.reason})
   if(result.error)throw result.error
   return NextResponse.json(result.data?{ok:true}:{error:'Unsafe retry rejected; review provider identity, expiry and activation boundary'},{status:result.data?200:409})
  }
  const result=await db.rpc('retry_operation',{p_key:body.id,p_actor:await adminSessionId(),p_reason:body.reason})
  if(result.error)throw result.error
  return NextResponse.json(result.data?{ok:true}:{error:'Job is not awaiting review or is leased'},{status:result.data?200:409})
 } catch { return NextResponse.json({error:'Operations unavailable. Verify the operations migration.'},{status:503}) }
}
