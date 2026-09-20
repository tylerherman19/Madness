import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, escapeIlike } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { hashPassword, passwordValidationError } from '@/lib/password'
import { getDb } from '@/lib/testMode'

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await req.json()
    const name = typeof body.full_name === 'string' ? body.full_name.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const passwordError = passwordValidationError(body.password)

    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (name.length > 80) return NextResponse.json({ error: 'Name too long (max 80 characters)' }, { status: 400 })
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 })

    const supabase = await getDb()
    const { data: existing, error: lookupError } = await supabase
      .from('players')
      .select('id')
      .ilike('email', escapeIlike(email))
      .limit(1)
      .maybeSingle()

    if (lookupError) {
      console.error('admin player lookup error', lookupError)
      return NextResponse.json({ error: 'Failed to check email address' }, { status: 500 })
    }
    if (existing) return NextResponse.json({ error: 'An account with that email already exists' }, { status: 409 })

    const { data: player, error: insertError } = await supabase
      .from('players')
      .insert({
        full_name: name,
        email,
        phone: null,
        venmo_handle: null,
        pin_hash: await hashPassword(body.password),
        paid: false,
        status: 'alive',
      })
      .select('id')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json({ error: 'An account with that email already exists' }, { status: 409 })
      }
      console.error('admin player insert error', insertError)
      return NextResponse.json({ error: 'Failed to add player' }, { status: 500 })
    }

    await logAudit(supabase, {
      event_type: 'player-signed-up',
      actor: 'admin',
      player_id: player.id,
      player_name: name,
      message: `Admin added ${name}`,
      details: { email },
    })

    revalidatePath('/')
    revalidatePath('/standings')
    revalidatePath('/admin/players')
    return NextResponse.json({ ok: true, playerId: player.id })
  } catch (err) {
    console.error('admin add player error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
