import { randomBytes, createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import {sealRequest,FROM_EMAIL} from '@/lib/delivery'
import {adminSessionId} from '@/lib/session'
import { serverError } from '@/lib/alerts'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  const { id } = await params
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const supabase = await getDb()

  const { data: player } = await supabase
    .from('players')
    .select('id, full_name, email')
    .eq('id', id)
    .single()

  if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 })

  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const resetUrl=new URL('/reset-password',process.env.NEXT_PUBLIC_APP_URL ?? 'https://madness-cyan.vercel.app')
  resetUrl.searchParams.set('token',token)
  try {
    const encrypted=sealRequest({from:FROM_EMAIL,to:player.email,subject:'Reset your Madness password',text:`Choose a new password: ${resetUrl}. This link expires in one hour.`})
    const {data,error}=await supabase.rpc('request_password_reset',{p_player:id,p_hash:tokenHash,p_expires:expires,p_encrypted:encrypted,p_actor:await adminSessionId()})
    if(error) throw error
    return NextResponse.json({ok:true,emailSent:false,notificationId:data,message:'Reset request recorded. Delivery follows the configured email mode.'})
  } catch(error) {return serverError('api/players/regen-pin',error,'Recovery unavailable. Configure the restricted recovery encryption key before requesting a reset.',503)}
}
