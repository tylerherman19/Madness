import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { MAX_PASSWORD_LENGTH, verifyPassword } from '@/lib/password'
import { createSession } from '@/lib/session'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { escapeIlike } from '@/lib/api'
import { serverError } from '@/lib/alerts'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid login request' }, { status: 400 })
    const { email, password } = body

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    if (typeof email !== 'string' || !email.trim() || email.length > 254) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 400 })
    }

    const identity = email.trim().toLowerCase()
    const ip = await getIP()
    const accountKey = createHash('sha256').update(identity).digest('hex')
    const limits = await Promise.all([
      checkRateLimit(`login-account:${accountKey}`, 10, 15 * 60),
      checkRateLimit(`login-network:${ip}`, 1000, 15 * 60),
    ])
    if (limits.some(limit => !limit.allowed)) return NextResponse.json(
      { error: 'Too many login attempts. Try again in 15 minutes.' },
      { status: 429, headers: { 'Retry-After': '900' } }
    )
    const supabase = await getDb()
    const { data: players, error } = await supabase.from('players')
      .select('id, full_name, pin_hash, status')
      .ilike('email', escapeIlike(identity)).limit(2)
    if (error) throw error
    const player = players?.length === 1 ? players[0] : null
    if (!player || !(await verifyPassword(password, player.pin_hash))) {
      return NextResponse.json({ error: 'Invalid email or password. Check both and try again.' }, { status: 401 })
    }

    await createSession({
      player_id: player.id,
      full_name: player.full_name,
      is_admin: false,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })

    return NextResponse.json({ ok: true, full_name: player.full_name })
  } catch (err) {
    return serverError('api/auth/login', err)
  }
}
