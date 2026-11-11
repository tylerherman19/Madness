import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { RESET_TOKEN_PATTERN, hashPassword, hashResetToken, isMissingFunction, passwordValidationError } from '@/lib/password'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { firstExceeded, resetLinkLimits } from '@/lib/rateLimitPolicy'
import { logAudit } from '@/lib/audit'
import { serverError } from '@/lib/alerts'

const MESSAGES: Record<string, string> = {
  used: 'This reset link has already been used. Ask the organizer for a new one.',
  expired: 'This reset link has expired. Ask the organizer for a new one.',
  invalid: 'This reset link is invalid or expired.',
}

export async function POST(req: NextRequest) {
  try {
    const ip = await getIP()
    const body = await req.json().catch(() => null)
    const token = typeof body?.token === 'string' ? body.token : ''
    // Keyed by the token's hash; the token itself never reaches the limiter, logs or audit rows.
    const wellFormed = RESET_TOKEN_PATTERN.test(token)
    if (await firstExceeded(resetLinkLimits(wellFormed ? hashResetToken(token) : null, ip), checkRateLimit)) {
      return NextResponse.json({ error: 'Too many attempts. Try again in an hour.' }, { status: 429, headers: { 'Retry-After': '3600' } })
    }
    const passwordError = passwordValidationError(body?.password)
    if (!wellFormed || passwordError) {
      return NextResponse.json({ error: passwordError || MESSAGES.invalid }, { status: 400 })
    }

    const supabase = await getDb()
    const tokenHash = hashResetToken(token)
    const passwordHash = await hashPassword(body.password)
    // One locked statement in the database decides the outcome, so two
    // simultaneous uses of one link cannot both change the password.
    const { data, error } = await supabase.rpc('consume_password_reset_link', { p_hash: tokenHash, p_password_hash: passwordHash })
    if (error && !isMissingFunction(error)) throw new Error(`Password reset failed (${error.code ?? 'database'})`)
    if (!error) {
      const status = typeof data?.status === 'string' ? data.status : 'invalid'
      if (status !== 'ok') return NextResponse.json({ error: MESSAGES[status] ?? MESSAGES.invalid }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    // Before migration 032: a single conditional UPDATE is still atomic.
    const { data: player, error: updateError } = await supabase.from('players')
      .update({ pin_hash: passwordHash, pin_reset_token: null, pin_reset_expires: null })
      .eq('pin_reset_token', tokenHash)
      .gt('pin_reset_expires', new Date().toISOString())
      .select('id, full_name')
      .maybeSingle()
    if (updateError) throw new Error(`Password reset failed (${updateError.code ?? 'database'})`)
    if (!player) return NextResponse.json({ error: MESSAGES.invalid }, { status: 400 })
    await logAudit(supabase, {
      event_type: 'password-reset',
      actor: 'player',
      player_id: player.id,
      player_name: player.full_name,
      message: `${player.full_name} changed their password using a reset link`,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError('api/auth/reset-password', err, 'Could not reset password')
  }
}
