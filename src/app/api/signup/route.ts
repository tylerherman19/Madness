import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { hashPassword } from '@/lib/password'
import { signupValidationError, TERMS_VERSION, type SignupInput } from '@/lib/signupValidation'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { escapeIlike } from '@/lib/api'
import { haveSignupsClosed } from '@/lib/season'
import { logAudit } from '@/lib/audit'
import { serverError } from '@/lib/alerts'

export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json().catch(() => null)
    const validationError = signupValidationError(body)
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
    const { full_name, email, phone, venmo, password } = body as SignupInput

    // Enforced server-side, not just hidden in the UI — the whole point is to
    // stop late signups once Slate 1's picks have locked.
    if (await haveSignupsClosed(true)) {
      return NextResponse.json({ error: 'Signups are closed — Slate 1 picks have locked.' }, { status: 403 })
    }

    const ip = await getIP()
    const identityKey = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
    const limits = await Promise.all([
      checkRateLimit(`signup-account:${identityKey}`, 5, 60 * 60),
      checkRateLimit(`signup-network:${ip}`, 1000, 60 * 60),
    ])
    const allowed = limits.every(limit => limit.allowed)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many signup attempts. Try again in an hour.' },
        { status: 429 }
      )
    }

    const name = full_name.trim()
    const emailLower = email.trim().toLowerCase()

    const supabase = await getDb()

    // Check for duplicate email. .limit(1) + maybeSingle() instead of
    // .single() — .single() errors out (leaving data undefined) when more
    // than one row matches, which would let a case-variant duplicate slip
    // past this check.
    const { data: byEmail, error: emailReadError } = await supabase
      .from('players')
      .select('id')
      .ilike('email', escapeIlike(emailLower))
      .limit(1)
      .maybeSingle()

    if (emailReadError) throw emailReadError
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
      return serverError('api/signup', insertError, 'Failed to create account')
    }

    await logAudit(supabase, {
      event_type: 'player-signed-up',
      actor: 'player',
      player_id: inserted.id,
      player_name: name,
      message: `${name} signed up`,
      details: { email: emailLower, terms_version: TERMS_VERSION, acceptance_method: 'account-creation' },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError('api/signup', err)
  }
}
