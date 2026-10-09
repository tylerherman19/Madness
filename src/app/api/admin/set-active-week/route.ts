import { NextRequest, NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { serverError } from '@/lib/alerts'

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

    const { error } = await supabase.rpc('activate_slate', { p_slate_id: slate_id })
    if (error) return serverError('api/admin/set-active-week', error, error.message)

    await logAudit(supabase, {
      event_type: 'slate-activated',
      actor: 'admin',
      message: `Admin set Slate ${slate.slate_number} (${slate.season_year}) as the active slate`,
      details: { slate_id, slate_number: slate.slate_number, season_year: slate.season_year },
    })

    revalidateContest()
    return NextResponse.json({ ok: true, slate_number: slate.slate_number, season_year: slate.season_year })
  } catch (err) {
    return serverError('api/admin/set-active-week', err)
  }
}
