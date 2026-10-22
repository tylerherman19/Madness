import { NextRequest,NextResponse } from 'next/server'
import { requireAdmin,isUuid } from '@/lib/api'
import { getDb } from '@/lib/testMode'
import { adminSessionId } from '@/lib/session'
import { serverError } from '@/lib/alerts'
export async function POST(req:NextRequest) {
 const unauthorized=await requireAdmin();if(unauthorized)return unauthorized
 try {
  const body=await req.json()
  if(typeof body.subject!=='string'||!body.subject.trim()||body.subject.length>150||typeof body.message!=='string'||!body.message.trim()||body.message.length>5000||!['all','alive','unpicked','selected'].includes(body.audience)||!isUuid(body.request_id))return NextResponse.json({error:'Valid subject, message, audience and request ID required'},{status:400})
  if(body.audience==='selected'&&(!Array.isArray(body.selected_ids)||!body.selected_ids.length||body.selected_ids.length>5000||body.selected_ids.some((id:unknown)=>typeof id!=='string'||!isUuid(id))))return NextResponse.json({error:'Choose valid recipients'},{status:400})
  const db=await getDb()
  const {data:requirement,error:reqError}=await db.rpc('active_pick_requirement');if(reqError)throw reqError
  if(body.audience==='unpicked'&&!requirement)return NextResponse.json({error:'No active period'},{status:409})
  const {data,error}=await db.from('email_campaigns').upsert({request_id:body.request_id,subject:body.subject.trim(),message:body.message.trim(),audience:body.audience,selected_ids:body.selected_ids??[],actor:await adminSessionId(),slate_id:requirement?.slate_id,period_ids:requirement?.period_ids??[],quota:requirement?.quota??1,provenance:process.env.VERCEL_ENV==='production'?'production':'test'},{onConflict:'request_id',ignoreDuplicates:true})
  if(error)throw error
  void data
  const campaign=await db.from('email_campaigns').select('id,status,subject,message,audience').eq('request_id',body.request_id).single()
  if(campaign.error)throw campaign.error
  if(campaign.data.subject!==body.subject.trim()||campaign.data.message!==body.message.trim()||campaign.data.audience!==body.audience)return NextResponse.json({error:'Request ID already belongs to another campaign'},{status:409})
  return NextResponse.json({ok:true,campaignId:campaign.data.id,status:campaign.data.status,progressUrl:`/admin/system/email?campaign=${campaign.data.id}`},{status:202})
 } catch(error){return serverError('api/admin/broadcast',error)}
}
