import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Choose a notification preference' }, { status: 400 })
  const db = await getDb()
  const { error } = await db.from('players').update({ notifications_enabled: body.enabled }).eq('id', session.player_id)
  if (error) return NextResponse.json({ error: 'Could not save preferences' }, { status: 503 })
  return NextResponse.json({ ok: true })
}
