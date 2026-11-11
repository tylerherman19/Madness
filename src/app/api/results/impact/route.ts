import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { serverError } from '@/lib/alerts'

// How many entries picked each team in a game, shown before a result change or void is confirmed.
export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  try {
    const gameId = req.nextUrl.searchParams.get('game_id')
    if (!isUuid(gameId)) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    const { data, error } = await (await getDb()).rpc('pick_impact', { p_game: gameId })
    if (error) {
      if (error.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 404 })
      return serverError('api/results/impact', error)
    }
    return NextResponse.json({ ok: true, impact: data })
  } catch (err) {
    return serverError('api/results/impact', err)
  }
}
