import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { hashPassword, passwordValidationError } from '@/lib/password'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { logAudit } from '@/lib/audit'
import { serverError } from '@/lib/alerts'

const TOKEN_RE = /^[a-f0-9]{64}$/i

export async function POST(req: NextRequest) {
  const ip = await getIP()
  const { allowed } = await checkRateLimit(`reset-password:${ip}`, 10, 60 * 60)
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again in an hour.' }, { status: 429 })

  const body = await req.json().catch(() => null)
  const token = body?.token
  const passwordError = passwordValidationError(body?.password)
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || passwordError) {
    return NextResponse.json({ error: passwordError || 'Invalid reset link' }, { status: 400 })
  }

  const supabase = await getDb()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const passwordHash = await hashPassword(body.password)
  const { data: player, error } = await supabase.from('players')
    .update({ pin_hash: passwordHash, pin_reset_token: null, pin_reset_expires: null })
    .eq('pin_reset_token', tokenHash)
    .gt('pin_reset_expires', new Date().toISOString())
    .select('id, full_name')
    .maybeSingle()

  if (error) {
    return serverError('api/auth/reset-password', error, 'Could not reset password')
  }
  if (!player) return NextResponse.json({ error: 'This reset link is invalid or expired.' }, { status: 400 })

  await logAudit(supabase, {
    event_type: 'password-reset',
    actor: 'player',
    player_id: player.id,
    player_name: player.full_name,
    message: `${player.full_name} changed their password using a reset link`,
  })
  return NextResponse.json({ ok: true })
}
