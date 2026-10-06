import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid, escapeIlike, readJsonObject, badRequest, serverError } from '@/lib/api'
import { normalizeEmail } from '@/lib/validation'
import { logAudit } from '@/lib/audit'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  const { id } = await params
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await readJsonObject(req)
  if (!body) return badRequest()
  const supabase = await getDb()

  const allowed = ['paid', 'status', 'elimination_reason', 'elimination_slate', 'full_name', 'email']
  const updates: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }
  if ('status' in updates && updates.status !== 'alive' && updates.status !== 'eliminated') {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  if ('paid' in updates && typeof updates.paid !== 'boolean') {
    return NextResponse.json({ error: 'paid must be true or false' }, { status: 400 })
  }
  if ('elimination_reason' in updates) {
    const reason = updates.elimination_reason
    if (reason !== null && typeof reason !== 'string') return badRequest('Invalid elimination reason')
    updates.elimination_reason = typeof reason === 'string' ? reason.trim().slice(0, 200) || null : null
  }
  if ('elimination_slate' in updates) {
    const slate = updates.elimination_slate
    if (slate !== null && !(Number.isInteger(slate) && (slate as number) >= 0 && (slate as number) <= 10_000)) {
      return badRequest('Invalid elimination slate')
    }
  }
  // Restoring a player clears the elimination record so standings and the
  // recap don't keep showing a stale "out on slate N".
  if (updates.status === 'alive') {
    updates.elimination_reason = null
    updates.elimination_slate = null
  }

  // full_name is the login key but doesn't have to be unique — login tries
  // every same-named candidate's password (see /api/auth/login). Email stays
  // unique so each entry still has one stable contact identity.
  if ('full_name' in updates) {
    const name = typeof updates.full_name === 'string' ? updates.full_name.trim() : ''
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (name.length > 80) return NextResponse.json({ error: 'Name too long (max 80 characters)' }, { status: 400 })
    updates.full_name = name
  }
  if ('email' in updates) {
    const email = normalizeEmail(updates.email)
    if (!email) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }
    const { data: byEmail, error: lookupError } = await supabase
      .from('players')
      .select('id')
      .ilike('email', escapeIlike(email))
      .neq('id', id)
      .limit(1)
      .maybeSingle()
    if (lookupError) return serverError('player email lookup failed', lookupError)
    if (byEmail) return NextResponse.json({ error: 'An account with that email already exists' }, { status: 409 })
    updates.email = email
  }

  const { data: player, error } = await supabase
    .from('players')
    .update(updates)
    .eq('id', id)
    .select('full_name')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'An account with that email already exists' }, { status: 409 })
    return serverError('player update failed', error, 'Failed to update player')
  }
  if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 })

  const changes = Object.entries(updates).map(([k, v]) => `${k}=${String(v)}`).join(', ')
  await logAudit(supabase, {
    event_type: 'player-updated',
    actor: 'admin',
    player_id: id,
    player_name: player?.full_name ?? null,
    message: `Admin updated ${player?.full_name ?? 'player'}: ${changes}`,
    details: updates,
  })

  revalidatePath('/')
  return NextResponse.json({ ok: true })
}

export async function DELETE(
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

  // Snapshot the entry and its picks before the rows disappear (picks cascade).
  // The audit trail is the only place a deleted player remains visible, and
  // this snapshot is what an organizer would use to re-create a mistaken delete.
  const { data: player, error: lookupError } = await supabase
    .from('players')
    .select('full_name, email, phone, venmo_handle, paid, status, elimination_reason, elimination_slate, created_at')
    .eq('id', id)
    .maybeSingle()
  if (lookupError) return serverError('player delete lookup failed', lookupError, 'Failed to delete player')
  if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 })

  const { data: picks } = await supabase
    .from('picks')
    .select('slate_id, team, seed, auto_assigned, submitted_by_admin, created_at')
    .eq('player_id', id)
    .order('created_at')

  const { error } = await supabase.from('players').delete().eq('id', id)
  if (error) return serverError('player delete failed', error, 'Failed to delete player')

  await logAudit(supabase, {
    event_type: 'player-deleted',
    actor: 'admin',
    player_id: id,
    player_name: player.full_name,
    message: `Admin deleted player ${player.full_name}`,
    details: { snapshot: player, picks: picks ?? [] },
  })

  revalidatePath('/')
  return NextResponse.json({ ok: true })
}
