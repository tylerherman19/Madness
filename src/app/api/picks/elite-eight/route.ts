import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { getSession } from '@/lib/session'
import { isUuid, readJsonObject } from '@/lib/api'
import { checkRateLimit } from '@/lib/rateLimit'
import { revalidateContest } from '@/lib/revalidateContest'
import { serverError } from '@/lib/alerts'

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Sign in to submit your picks.' }, { status: 401 })
  const body = await readJsonObject(request)
  if (!body || !isUuid(body.request_id) || !Array.isArray(body.picks) || body.picks.length !== 2 ||
      !body.picks.every(pick => pick && isUuid(pick.slate_id) && typeof pick.team === 'string' &&
        pick.team.length > 0 && pick.team.length <= 80 &&
        (pick.pick_id == null || (isUuid(pick.pick_id) && typeof pick.expected === 'string' && Number.isFinite(Date.parse(pick.expected)))))) {
    return NextResponse.json({ error: 'Choose two Elite Eight teams before submitting.' }, { status: 400 })
  }
  const pair = body.picks.map(pick => ({ slate_id: pick.slate_id, team: pick.team, pick_id: pick.pick_id ?? null, expected: pick.expected ?? null }))
  const { allowed } = await checkRateLimit(`pick:${session.player_id}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many pick changes. Try again in a minute.' }, { status: 429 })
  try {
    const db = await getDb()
    const { data, error } = await db.rpc('save_march_2027_elite_pair', {
      p_player: session.player_id, p_request: body.request_id, p_pair: pair,
    })
    if (error?.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 409 })
    if (error) throw error
    revalidateContest({ picksOnly: true })
    return NextResponse.json({ ok: true, ...data })
  } catch (error) {
    return serverError('api/picks/elite-eight', error, 'The save could not be confirmed. Retry the same two picks.')
  }
}
