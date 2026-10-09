import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireAdmin, requireCron } from '@/lib/api'
import { formatCentralTime, slateDeadline } from '@/lib/deadline'
import { getPoolConfig } from '@/lib/pool'
import { buildPickPeriods, sharedRoundPickQuota } from '@/lib/competition'
import { loadAll, loadGamesForSlates } from '@/lib/seasonData'
import type { Game, Slate } from '@/types'
import { serverError } from '@/lib/alerts'

export const maxDuration = 300
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000
export async function GET(req: NextRequest) {
  const unauthorized = requireCron(req)
  return unauthorized ?? run()
}
export async function POST() {
  const unauthorized = await requireAdmin()
  return unauthorized ?? run()
}
async function run() {
  try {
    const db = await getDb()
    const { data: slate, error } = await db.from('slates').select('*').eq('is_active', true).maybeSingle<Slate>()
    if (error) throw error
    if (!slate) return NextResponse.json({ ok: true, queued: 0, message: 'No active day' })
    const { data: games, error: gamesError } = await db.from('games').select('*').eq('slate_id', slate.id)
    if (gamesError) throw gamesError
    const deadline = slateDeadline(slate, (games ?? []) as Game[])
    const now = await getEffectiveNow()
    if (!deadline || deadline <= now || deadline.getTime() - now.getTime() > REMINDER_WINDOW_MS) {
      return NextResponse.json({ ok: true, queued: 0, message: 'Outside the pre-deadline reminder window' })
    }
    const pool = await getPoolConfig(db, true)
    const { data: slates, error: slatesError } = await db.from('slates').select('*').eq('season_year', slate.season_year)
    if (slatesError) throw slatesError
    const contestSlates = (slates ?? []).filter(day => !pool.starts_on || day.slate_date >= pool.starts_on)
    const allGames = await loadGamesForSlates(db, contestSlates.map(row => row.id))
    const periods = buildPickPeriods(pool.competition_mode, contestSlates, allGames)
    const period = periods.find(row => row.id === slate.id)
    const sharedQuota = sharedRoundPickQuota(pool.competition_mode, pool.pick_frequency, period?.round ?? null)
    const periodIds = sharedQuota ? periods.filter(row => row.round === period?.round).map(row => row.id) : [slate.id]
    const players = await loadAll<{ id: string; email: string; status: string; full_name: string }>(db, 'players', 'id, email, status, full_name')
    let queued = 0
    // One RPC per 200 entries; Postgres checks eligibility and deadline at insert time.
    // Durable, idempotent events replace a 0.6-second-per-recipient send loop.
    for (let offset = 0; offset < players.length; offset += 200) {
      if (await getEffectiveNow() >= deadline) break
      const { data, error: queueError } = await db.rpc('queue_pick_reminders', {
        p_slate_id: slate.id, p_player_ids: players.slice(offset, offset + 200).map(player => player.id),
        p_period_ids: periodIds, p_quota: sharedQuota ?? 1,
        p_deadline: deadline.toISOString(), p_deadline_label: formatCentralTime(deadline),
      })
      if (queueError) throw queueError
      queued += Number(data ?? 0)
    }
    return NextResponse.json({ ok: true, queued, reminded: 0, suppressed: true, message: 'Reminder events recorded. Email delivery is disabled.' })
  } catch (error) { return serverError('api/cron/reminders', error) }
}
