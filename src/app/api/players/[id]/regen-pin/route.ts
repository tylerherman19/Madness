import { randomBytes, createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { sendPasswordResetEmail } from '@/lib/email'
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
  const { error } = await supabase.from('players').update({
    pin_reset_token: tokenHash,
    pin_reset_expires: expires,
  }).eq('id', id)
  if (error) return serverError('api/players/regen-pin', error, 'Failed to create reset request')

  const delivery = await sendPasswordResetEmail(player.email, player.full_name, token)

  await logAudit(supabase, {
    event_type: 'password-reset-requested',
    actor: 'admin',
    player_id: player.id,
    player_name: player.full_name,
    message: `Admin requested a password reset for ${player.full_name}`,
    details: { email_sent: delivery.sent },
  })

  if (!delivery.ok) {
    return NextResponse.json({ error: 'Reset request created, but the email could not be sent.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, emailSent: delivery.sent })
}
