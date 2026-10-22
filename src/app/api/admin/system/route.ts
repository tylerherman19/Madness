import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isUuid } from '@/lib/api'
import { adminSessionId } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import { serverError } from '@/lib/alerts'
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  try {
    const body = await req.json(),
      db = await getDb(),
      actor = await adminSessionId()
    if (
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 3 ||
      body.reason.length > 500
    )
      return NextResponse.json(
        { error: 'An explanation is required' },
        { status: 400 },
      )
    let result
    if (body.action === 'mode') {
      if (!['record-only', 'test-recipients', 'live'].includes(body.mode))
        return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
      const ready =
        process.env.EMAILS_ENABLED === 'true' &&
        process.env.OUTBOX_DELIVERY_ENABLED === 'true' &&
        !!process.env.RESEND_API_KEY
      if (body.mode !== 'record-only' && !ready)
        return NextResponse.json(
          {
            error:
              'Delivery remains off. Configure the master switch, outbox switch and Resend key before selecting a sending mode.',
          },
          { status: 409 },
        )
      if (
        body.mode === 'live' &&
        process.env.LIVE_EMAIL_ACTIVATION_APPROVED !== 'true'
      )
        return NextResponse.json(
          {
            error:
              'Live activation requires a separately approved deployment configuration (LIVE_EMAIL_ACTIVATION_APPROVED).',
          },
          { status: 409 },
        )
      const allowlist = String(body.allowlist ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      if (
        allowlist.length > 50 ||
        allowlist.some((s) => !/^\S+@\S+\.\S+$/.test(s))
      )
        return NextResponse.json(
          { error: 'Invalid test allowlist' },
          { status: 400 },
        )
      result = await db.rpc('set_delivery_mode', {
        p_mode: body.mode,
        p_allowlist: allowlist,
        p_actor: actor,
        p_reason: body.reason,
      })
    } else if (body.action === 'cancel-campaign' && isUuid(body.id))
      result = await db.rpc('cancel_campaign', {
        p_id: body.id,
        p_actor: actor,
        p_reason: body.reason,
      })
    else if (body.action === 'retry-message' && isUuid(body.id)) {
      result = await db.rpc('retry_notification', {
        p_id: body.id,
        p_actor: actor,
        p_reason: body.reason,
      })
      if (!result.error && !result.data)
        return NextResponse.json(
          {
            error:
              'Retry rejected: check expiry, activation boundary, active lease and provider ambiguity.',
          },
          { status: 409 },
        )
    } else if (body.action === 'reconcile')
      result = await db.rpc('reconcile_contest')
    else return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    if (result.error) throw result.error
    return NextResponse.json({ ok: true, result: result.data })
  } catch (error) {
    return serverError('api/admin/system', error)
  }
}
