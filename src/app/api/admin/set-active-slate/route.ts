import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { slate_id } = await req.json()
    if (!isUuid(slate_id)) {
      return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })
    }

    const supabase = await getDb()
    const { data: slate, error: lookupErr } = await supabase
      .from('slates')
      .select('id, slate_number, season_year')
      .eq('id', slate_id)
      .single()
    if (lookupErr || !slate) {
      return NextResponse.json({ error: 'Slate not found' }, { status: 404 })
    }

    // Deactivate by the flag itself. Keying off slate_number missed a slate
    // still carrying the provisional number 0 that getOrCreateSlate inserts,
    // which left two slates active — and the one-active partial index then
    // rejects the activation below.
    await supabase.from('slates').update({ is_active: false }).eq('is_active', true)
    const { error } = await supabase.from('slates').update({ is_active: true }).eq('id', slate_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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
