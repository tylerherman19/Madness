import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { adminSessionId } from '@/lib/session'
import { serverError } from '@/lib/alerts'
import { logAudit } from '@/lib/audit'
import { siteUrl } from '@/lib/site'
import { RESET_LINK_MINUTES, hashResetToken, isMissingFunction, newResetToken, resetLinkUrl } from '@/lib/password'

// Creates a one-time password reset link for a participant and returns it to
// the signed-in organizer exactly once. Nothing is emailed or queued. Only the
// token's hash is stored, so the link cannot be retrieved again; creating a new
// link invalidates any earlier unused one for the same participant.
const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' }

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
  try {
    const supabase = await getDb()
    const token = newResetToken()
    const tokenHash = hashResetToken(token)
    const expiresAt = new Date(Date.now() + RESET_LINK_MINUTES * 60 * 1000).toISOString()
    const actor = await adminSessionId()

    let fullName: string | null = null
    const { data, error } = await supabase.rpc('issue_password_reset_link', { p_player: id, p_hash: tokenHash, p_expires: expiresAt, p_actor: actor })
    if (error && isMissingFunction(error)) {
      // Before migration 032: same columns, one statement, audited separately.
      const { data: player, error: updateError } = await supabase.from('players')
        .update({ pin_reset_token: tokenHash, pin_reset_expires: expiresAt })
        .eq('id', id).select('id, full_name').maybeSingle()
      if (updateError) throw new Error(`Reset link could not be saved (${updateError.code ?? 'database'})`)
      if (player) {
        fullName = player.full_name
        await logAudit(supabase, { event_type: 'password-reset-link-created', actor: 'admin', player_id: player.id, player_name: player.full_name, message: 'Organizer created a one-time password reset link', details: { expires_at: expiresAt } })
      }
    } else if (error) {
      throw new Error(`Reset link could not be saved (${error.code ?? 'database'})`)
    } else if (data?.status === 'ok') {
      fullName = typeof data.full_name === 'string' ? data.full_name : ''
    }
    if (fullName === null) return NextResponse.json({ error: 'Player not found' }, { status: 404 })

    return NextResponse.json(
      { ok: true, resetUrl: resetLinkUrl(siteUrl, token), expiresAt, expiresInMinutes: RESET_LINK_MINUTES, fullName },
      { headers: NO_STORE }
    )
  } catch (error) {
    return serverError('api/players/regen-pin', error, 'Could not create a reset link. Try again.')
  }
}
