import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid, readJsonObject, serverError } from '@/lib/api'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const slate_id = (await readJsonObject(req))?.slate_id
    if (!isUuid(slate_id)) {
      return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })
    }

    const supabase = await getDb()
    const { data: slate, error: lookupErr } = await supabase
      .from('slates')
      .select('id, slate_number, season_year')
      .eq('id', slate_id)
      .maybeSingle()
    if (lookupErr) return serverError('set-active-slate lookup error', lookupErr, 'Could not load that slate')
    if (!slate) {
      return NextResponse.json({ error: 'Slate not found' }, { status: 404 })
    }

    // Deactivate everything else first (the one-active-slate unique index
    // forbids two), and check each step: a silent failure here used to leave
    // the pool with no active slate at all.
    const { error: clearError } = await supabase.from('slates').update({ is_active: false }).eq('is_active', true).neq('id', slate_id)
    if (clearError) return serverError('set-active-slate clear error', clearError, 'Failed to change the active slate')
    const { error } = await supabase.from('slates').update({ is_active: true }).eq('id', slate_id)
    if (error) return serverError('set-active-slate error', error, 'Failed to activate that slate. No slate may be active — try again.')

    await logAudit(supabase, {
      event_type: 'slate-activated',
      actor: 'admin',
      message: `Admin set Slate ${slate.slate_number} (${slate.season_year}) as the active slate`,
      details: { slate_id, slate_number: slate.slate_number, season_year: slate.season_year },
    })

    revalidatePath('/')
    return NextResponse.json({ ok: true, slate_number: slate.slate_number, season_year: slate.season_year })
  } catch (err) {
    console.error('set-active-slate error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
