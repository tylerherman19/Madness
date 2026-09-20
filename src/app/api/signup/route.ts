import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { hashPassword, passwordValidationError } from '@/lib/password'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { escapeIlike } from '@/lib/api'
import { haveSignupsClosed } from '@/lib/season'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  try {
    // Enforced server-side, not just hidden in the UI — the whole point is to
    // stop late signups once Slate 1's picks have locked.
    if (await haveSignupsClosed()) {
      return NextResponse.json({ error: 'Signups are closed — Slate 1 picks have locked.' }, { status: 403 })
    }

    const ip = await getIP()
    const { allowed } = await checkRateLimit(`signup:${ip}`, 5, 60 * 60)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many signups from this device. Try again in an hour.' },
        { status: 429 }
      )
    }

    const { full_name, email, phone, venmo, password } = await req.json()

    if (!full_name?.trim() || !email?.trim() || !phone?.trim() || !venmo?.trim()) {
      return NextResponse.json({ error: 'Name, email, phone, and Venmo handle are required' }, { status: 400 })
    }
    const passwordError = passwordValidationError(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const name = full_name.trim()
    const emailLower = email.trim().toLowerCase()

    if (name.length > 80) {
      return NextResponse.json({ error: 'Name too long (max 80 characters)' }, { status: 400 })
    }
    if (emailLower.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }
    if (phone && phone.length > 20) {
      return NextResponse.json({ error: 'Phone number too long' }, { status: 400 })
    }
    if (venmo && venmo.length > 50) {
      return NextResponse.json({ error: 'Venmo handle too long' }, { status: 400 })
    }

    const supabase = await getDb()

    // Check for duplicate email. .limit(1) + maybeSingle() instead of
    // .single() — .single() errors out (leaving data undefined) when more
    // than one row matches, which would let a case-variant duplicate slip
    // past this check.
    const { data: byEmail } = await supabase
      .from('players')
      .select('id')
      .ilike('email', escapeIlike(emailLower))
      .limit(1)
      .maybeSingle()

    if (byEmail) {
      return NextResponse.json(
        { error: 'An account with that email already exists. Log in with the password you chose.' },
        { status: 409 }
      )
    }

    // The legacy database column is still named pin_hash, but it now stores
    // the bcrypt hash of the player-chosen password. Keeping the column avoids
    // a risky credential migration and lets existing entries keep logging in.
    const passwordHash = await hashPassword(password)

    const { data: inserted, error: insertError } = await supabase
      .from('players')
      .insert({
        full_name: name,
        email: emailLower,
        phone: phone?.trim() || null,
        venmo_handle: venmo?.trim() || null,
        pin_hash: passwordHash,
        paid: false,
        status: 'alive',
      })
      .select('id')
      .single()

    if (insertError) {
      // 23505 = unique violation. Two requests can both pass the email
      // dup-check above before either commits (e.g. a double-tap submit) and
      // then race on the DB's unique email constraint — report that as a
      // normal "already exists" case instead of a generic 500.
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'An account with that email already exists. Log in with your password.' },
          { status: 409 }
        )
      }
      console.error('signup insert error', insertError)
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 })
    }

    await logAudit(supabase, {
      event_type: 'player-signed-up',
      actor: 'player',
      player_id: inserted.id,
      player_name: name,
      message: `${name} signed up`,
      details: { email: emailLower },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('signup error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
