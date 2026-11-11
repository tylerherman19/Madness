import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { getActiveDayStatus, assignmentGuard } from '@/lib/slateStatus'
import { serverError } from '@/lib/alerts'

export const dynamic = 'force-dynamic'

// What an admin is about to do: ?action=advance, or ?action=activate&slate_id=...
export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  try {
    const action = req.nextUrl.searchParams.get('action')
    if (action !== 'advance' && action !== 'activate') return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    const db = await getDb()
    const status = await getActiveDayStatus(db, await getEffectiveNow())
    let to: string | null = null
    if (action === 'activate') {
      const id = req.nextUrl.searchParams.get('slate_id')
      if (!isUuid(id)) return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })
      const { data: target } = await db.from('slates').select('slate_date').eq('id', id).maybeSingle()
      if (!target) return NextResponse.json({ error: 'Slate not found' }, { status: 404 })
      to = target.slate_date
    } else if (status) {
      const { data: next } = await db.from('slates').select('slate_date').gt('slate_date', status.slateDate).order('slate_date').limit(1)
      to = next?.[0]?.slate_date ?? null
    }
    const guard = status && action === 'activate' ? assignmentGuard(status) : { blocked: false, message: null }
    return NextResponse.json({ from: status?.slateDate ?? null, to, status, blocked: guard.blocked, message: guard.message })
  } catch (error) {
    return serverError('api/admin/slate-preview', error)
  }
}
