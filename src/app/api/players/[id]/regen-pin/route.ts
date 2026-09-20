import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { hashPassword, passwordValidationError } from '@/lib/password'
import { logAudit } from '@/lib/audit'

export async function POST(
  req: NextRequest,
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

  const { password } = await req.json().catch(() => ({ password: null }))
  const passwordError = passwordValidationError(password)
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 })
  const pin_hash = await hashPassword(password)

  const { error } = await supabase.from('players').update({ pin_hash }).eq('id', id)
  if (error) return NextResponse.json({ error: 'Failed to update password' }, { status: 500 })

  await logAudit(supabase, {
    event_type: 'password-reset',
    actor: 'admin',
    player_id: player.id,
    player_name: player.full_name,
    message: `Admin reset the password for ${player.full_name}`,
    details: null,
  })

  return NextResponse.json({ ok: true })
}
