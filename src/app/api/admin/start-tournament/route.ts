import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isUuid } from '@/lib/api'
import { getDb } from '@/lib/testMode'
import { adminSessionId } from '@/lib/session'
import { revalidateContest } from '@/lib/revalidateContest'
import { MARCH_2027_START } from '@/lib/march2027'
import { serverError } from '@/lib/alerts'
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  try {
    const body = await req.json().catch(() => null)
    if (!body || !isUuid(body.pool_id) || !isUuid(body.slate_id) || body.confirmation !== 'START FRESH' || typeof body.reason !== 'string' || !body.reason.trim()) {
      return NextResponse.json({ error: 'Choose the opening day, enter a reason, and type START FRESH.' }, { status: 400 })
    }
    const db = await getDb()
    const { data: slate, error: lookupError } = await db.from('slates')
      .select('season_year,slate_date').eq('id', body.slate_id).maybeSingle()
    if (lookupError) throw lookupError
    if (!slate) return NextResponse.json({ error: 'Sync the tournament opening day first.' }, { status: 409 })
    if (slate.season_year === 2027 && slate.slate_date !== MARCH_2027_START) {
      return NextResponse.json({ error: 'March 18 is the only 2027 tournament opening day.' }, { status: 409 })
    }
    const { data, error } = await db.rpc('start_fresh_tournament', { p_expected_pool_id: body.pool_id,
      p_slate_id: body.slate_id, p_reason: body.reason.trim(), p_admin_session: await adminSessionId() })
    if (error?.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 409 })
    if (error) return serverError('api/admin/start-tournament', error, 'Could not archive and start the new contest. Nothing was changed.')
    revalidateContest()
    return NextResponse.json({ ok: true, archive_id: data })
  } catch (error) { return serverError('api/admin/start-tournament', error) }
}
