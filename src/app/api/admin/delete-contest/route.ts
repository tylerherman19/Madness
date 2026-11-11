import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isUuid } from '@/lib/api'
import { getDb } from '@/lib/testMode'
import { adminSessionId } from '@/lib/session'
import { revalidateContest } from '@/lib/revalidateContest'
import { serverError } from '@/lib/alerts'

// Permanently delete one ARCHIVED contest's entries and picks (migration 030,
// delete_archived_contest). The database refuses the active contest, any
// non-archived pool, a wrong name or an empty reason, and writes a verified
// recovery snapshot to contest_archives before deleting. `preview: true`
// returns the exact counts without changing anything. A repeat call after a
// deletion finds nothing left and is a no-op.
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !isUuid(body.pool_id)) {
      return NextResponse.json({ error: 'Choose an archived contest.' }, { status: 400 })
    }
    const db = await getDb()
    if (body.preview === true) {
      const { data, error } = await db.rpc('delete_archived_contest_preview', { p_pool_id: body.pool_id })
      if (error) return serverError('api/admin/delete-contest', error, 'Could not read the contest.')
      return NextResponse.json({ ok: true, preview: data })
    }
    if (typeof body.confirm_name !== 'string' || typeof body.reason !== 'string' || !body.reason.trim()) {
      return NextResponse.json({ error: 'Type the exact contest name and enter a reason.' }, { status: 400 })
    }
    const { data, error } = await db.rpc('delete_archived_contest', {
      p_pool_id: body.pool_id,
      p_confirm_name: body.confirm_name,
      p_reason: body.reason.trim(),
      p_admin_session: await adminSessionId(),
    })
    if (error?.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 409 })
    if (error) return serverError('api/admin/delete-contest', error, 'Could not delete the contest. Nothing was changed.')
    if (data?.deleted) revalidateContest()
    return NextResponse.json({ ok: true, result: data })
  } catch (error) {
    return serverError('api/admin/delete-contest', error)
  }
}
