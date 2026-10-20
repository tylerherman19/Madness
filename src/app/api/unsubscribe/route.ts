import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { verifyUnsubscribe } from '@/lib/unsubscribe'

// Turns pool emails off (or back on) for the player a signed link names.
// Mail apps' one-click button posts here with the id and token in the query;
// the /unsubscribe page posts JSON.
export async function POST(req: NextRequest) {
  const url = req.nextUrl
  const body = req.headers.get('content-type')?.includes('application/json') ? await req.json().catch(() => null) : null
  const playerId = body?.p ?? url.searchParams.get('p')
  const token = body?.t ?? url.searchParams.get('t')
  if (!verifyUnsubscribe(playerId, token)) return NextResponse.json({ error: 'This unsubscribe link is not valid.' }, { status: 400 })
  const enabled = body?.enabled === true
  const db = await getDb()
  const { error } = await db.from('players').update({ notifications_enabled: enabled }).eq('id', playerId)
  if (error) return NextResponse.json({ error: 'Could not save. Try again.' }, { status: 503 })
  return NextResponse.json({ ok: true, enabled })
}
