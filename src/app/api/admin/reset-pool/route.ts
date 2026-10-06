import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { requireAdmin, readJsonObject, serverError } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { logAudit } from '@/lib/audit'

const CONFIRM_PHRASE = 'RESET POOL'

// Wipes every player, slate, game, and pick from production (public schema)
// back to zero. Deliberately always targets `supabase` (prod) directly, never
// getDb() — this must never be reachable from the sandbox cookie path, and
// must always hit prod regardless of the admin's current test-mode state.
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const confirm = (await readJsonObject(req))?.confirm
    if (confirm !== CONFIRM_PHRASE) {
      return NextResponse.json({ error: `Must confirm with exact phrase "${CONFIRM_PHRASE}"` }, { status: 400 })
    }

    // Snapshot what's about to be destroyed — audit_log is deliberately not
    // cleared below, so this record outlives the reset.
    const [{ count: playerCount }, { count: pickCount }, { count: weekCount }] = await Promise.all([
      supabase.from('players').select('*', { count: 'exact', head: true }),
      supabase.from('picks').select('*', { count: 'exact', head: true }),
      supabase.from('slates').select('*', { count: 'exact', head: true }),
    ])

    // Children first, though FKs cascade anyway — explicit is safer than
    // relying on cascade order for a destructive, irreversible operation.
    const { error: picksError } = await supabase.from('picks').delete().not('id', 'is', null)
    if (picksError) return serverError('reset picks error', picksError, 'Failed to clear picks. Nothing else was deleted.')

    const { error: gamesError } = await supabase.from('games').delete().not('id', 'is', null)
    if (gamesError) return serverError('reset games error', gamesError, 'Failed to clear games after picks were cleared. Run the reset again.')

    const { error: weeksError } = await supabase.from('slates').delete().not('id', 'is', null)
    if (weeksError) return serverError('reset slates error', weeksError, 'Failed to clear slates after picks and games were cleared. Run the reset again.')

    const { error: playersError } = await supabase.from('players').delete().not('id', 'is', null)
    if (playersError) return serverError('reset players error', playersError, 'Failed to clear players after everything else was cleared. Run the reset again.')

    await logAudit(supabase, {
      event_type: 'pool-reset',
      actor: 'admin',
      message: `Admin reset the pool — wiped ${playerCount ?? 0} players, ${pickCount ?? 0} picks, ${weekCount ?? 0} slates`,
      details: { players: playerCount, picks: pickCount, slates: weekCount },
    })

    revalidatePath('/')

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('reset-pool error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
