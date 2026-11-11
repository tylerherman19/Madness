import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { gradeSlatePicks } from '@/lib/grading'
import { logAudit } from '@/lib/audit'
import type { Game } from '@/types'
import { serverError } from '@/lib/alerts'
import { revalidateContest } from '@/lib/revalidateContest'

// Grading awaits a paced elimination email per eliminated player.
export const maxDuration = 300

type Action = 'set' | 'release' | 'void' | 'unvoid'
const RPC: Record<Exclude<Action, 'set'>, string> = { release: 'release_result', void: 'void_game', unvoid: 'unvoid_game' }
const VALID_RESULTS = ['home_win', 'away_win', 'tie', 'pending']

function missingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || error.code === '42883' || /could not find the function|function .* does not exist/i.test(error.message ?? '')
}

// Administrator result operations: set (manual result), release back to ESPN, void and undo void.
// Every one needs a reason, is audited when it changes something, and is idempotent.
export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await req.json()
    const action: Action = body.action ?? 'set'
    const gameId = body.game_id
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const result = body.result
    if (!gameId || !['set', 'release', 'void', 'unvoid'].includes(action)) {
      return NextResponse.json({ error: 'Missing game_id or action' }, { status: 400 })
    }
    if (action === 'set' && !result) return NextResponse.json({ error: 'Missing game_id or result' }, { status: 400 })
    if (action === 'set' && !VALID_RESULTS.includes(result)) {
      return NextResponse.json({ error: 'Invalid result value' }, { status: 400 })
    }
    if (!isUuid(gameId)) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    if (reason.length < 3) return NextResponse.json({ error: 'Give a short reason (at least 3 characters).' }, { status: 400 })
    if (reason.length > 500) return NextResponse.json({ error: 'Reason is too long (max 500 characters).' }, { status: 400 })

    const supabase = await getDb()
    const rpc = action === 'set'
      ? await supabase.rpc('admin_set_result', { p_game: gameId, p_result: result, p_reason: reason })
      : await supabase.rpc(RPC[action], { p_game: gameId, p_reason: reason })
    if (rpc.error) {
      if (rpc.error.code === 'P0001') {
        const status = /not found/i.test(rpc.error.message) ? 404 : 400
        return NextResponse.json({ error: rpc.error.message }, { status })
      }
      if (!missingFunction(rpc.error) || action !== 'set') {
        if (missingFunction(rpc.error)) return NextResponse.json({ error: 'This action needs the latest database migration.' }, { status: 501 })
        return serverError('api/results', rpc.error)
      }
    }
    // Databases without migration 033 keep the original direct write.
    if (rpc.error) {
      const { error } = await supabase.from('games').update({ result }).eq('id', gameId)
      if (error) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    }
    const outcome = (rpc.data ?? { changed: true }) as { changed: boolean; previous?: string; home_team?: string; away_team?: string }

    const { data: game } = await supabase.from('games').select('*').eq('id', gameId).single()
    if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    const label = `${game.away_team}@${game.home_team}`
    const details = { game_id: gameId, home_team: game.home_team, away_team: game.away_team, result: game.result, previous: outcome.previous ?? null, reason }
    if (outcome.changed) {
      if (action === 'set') {
        await logAudit(supabase, { event_type: 'result-set', actor: 'admin',
          message: result === 'pending' ? `Admin cleared the result of ${label}` : `Admin set ${label} result to ${result}`, details })
      } else if (action === 'release') {
        await logAudit(supabase, { event_type: 'result-released', actor: 'admin', message: `Admin released ${label} to ESPN`, details })
      } else if (action === 'void') {
        await logAudit(supabase, { event_type: 'game-voided', actor: 'admin', message: `Admin voided ${label}`, details })
      } else {
        await logAudit(supabase, { event_type: 'void-undone', actor: 'admin', message: `Admin undid the void of ${label}`, details })
      }
    }

    // Recompute the slate from the stored results; marking a game final grades it immediately.
    let grading = null
    const { data: slate } = await supabase.from('slates').select('slate_number').eq('id', game.slate_id).single()
    const { data: weekGames } = await supabase.from('games').select('*').eq('slate_id', game.slate_id)
    const completedGames = ((weekGames || []) as Game[]).filter((g) => g.result !== 'pending')
    if (slate) grading = await gradeSlatePicks(supabase, game.slate_id, slate.slate_number, completedGames)

    revalidateContest()
    return NextResponse.json({ ok: true, changed: outcome.changed, game, grading })
  } catch (err) {
    return serverError('api/results', err)
  }
}
