import { NextRequest, NextResponse } from 'next/server'
import { revalidateContest } from '@/lib/revalidateContest'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { logAudit } from '@/lib/audit'
import { serverError } from '@/lib/alerts'
import { getActiveDayStatus, assignmentGuard } from '@/lib/slateStatus'
import { validReason } from '@/lib/slateGuard'

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await req.json().catch(() => null)
    const slate_id = body?.slate_id
    const override = body?.override === true
    if (!isUuid(slate_id)) {
      return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })
    }

    const reason = validReason(body?.reason)
    if (!reason) return NextResponse.json({ error: 'Enter a reason (3 to 500 characters)' }, { status: 400 })

    const supabase = await getDb()
    const { data: slate, error: lookupErr } = await supabase
      .from('slates')
      .select('id, slate_number, season_year')
      .eq('id', slate_id)
      .single()
    if (lookupErr || !slate) {
      return NextResponse.json({ error: 'Slate not found' }, { status: 404 })
    }

    // Authoritative server-side check, independent of what the client previewed.
    const current = await getActiveDayStatus(supabase, await getEffectiveNow())
    const guard = current && current.slateId !== slate_id ? assignmentGuard(current) : { blocked: false, message: null }
    if (guard.blocked && !override) {
      return NextResponse.json({ error: guard.message, code: 'assignment-incomplete' }, { status: 409 })
    }
    const overridden = guard.blocked && override

    const { error } = await supabase.rpc('activate_slate', { p_slate_id: slate_id })
    if (error) return serverError('api/admin/set-active-week', error, error.message)

    await logAudit(supabase, {
      event_type: 'slate-activated',
      actor: 'admin',
      message: `Admin set Slate ${slate.slate_number} (${slate.season_year}) as the active slate${overridden ? ' (override: auto-assignment had not completed)' : ''}`,
      details: {
        slate_id, slate_number: slate.slate_number, season_year: slate.season_year, reason,
        from_slate_date: current?.slateDate ?? null, override: Boolean(overridden),
        unpicked_at_change: current?.unpicked ?? null, auto_assign_completed: current?.autoAssignCompleted ?? null,
      },
    })

    revalidateContest()
    return NextResponse.json({ ok: true, slate_number: slate.slate_number, season_year: slate.season_year })
  } catch (err) {
    return serverError('api/admin/set-active-week', err)
  }
}
