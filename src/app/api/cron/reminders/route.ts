import { NextRequest, NextResponse } from 'next/server'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { requireCronOrAdmin } from '@/lib/api'
import { formatCentralTime, slateDeadline } from '@/lib/deadline'
import { sendReminderEmail, sleep, SEND_DELAY_MS } from '@/lib/email'
import type { Game } from '@/types'

// Sends are paced for Resend's ~2 req/sec limit — allow enough runtime for a
// full-group reminder batch.
export const maxDuration = 300

// Only nag once the lock is actually close — a slate can go active days
// before its first tip (the admin syncs ahead to get the site ready), and the
// daily cron would otherwise fire every single day the pool is active
// regardless of how far off the real deadline is. One day, since slates are
// now one day apart.
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const unauthorized = await requireCronOrAdmin(req)
  if (unauthorized) return unauthorized

  try {
    const supabase = await getDb()
    const { data: slate } = await supabase
      .from('slates')
      .select('*')
      .eq('is_active', true)
      .single()

    if (!slate) return NextResponse.json({ ok: true, message: 'No active slate' })

    const { data: games } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', slate.id)

    const deadline = slateDeadline(slate, (games || []) as Game[])
    if (!deadline) return NextResponse.json({ ok: true, message: 'No deadline found' })

    const now = await getEffectiveNow()
    const msUntilDeadline = deadline.getTime() - now.getTime()
    if (msUntilDeadline > REMINDER_WINDOW_MS) {
      return NextResponse.json({
        ok: true,
        message: `Deadline is ${formatCentralTime(deadline)} — too far out to remind yet`,
      })
    }

    const deadlineStr = formatCentralTime(deadline)

    // Find alive players without a pick this slate
    const { data: alivePlayers } = await supabase
      .from('players')
      .select('id, full_name, email')
      .eq('status', 'alive')

    const { data: existingPicks } = await supabase
      .from('picks')
      .select('player_id')
      .eq('slate_id', slate.id)

    const playersWithPicks = new Set(
      (existingPicks || []).map((p: { player_id: string }) => p.player_id)
    )

    const toRemind = (alivePlayers || []).filter(
      (p: { id: string }) => !playersWithPicks.has(p.id)
    )

    let reminded = 0
    const failures: string[] = []
    for (const player of toRemind) {
      if (!player.email) continue
      const result = await sendReminderEmail(
        player.email,
        player.full_name,
        slate.slate_number,
        deadlineStr
      )
      if (result.ok) reminded++
      else failures.push(player.full_name)
      if (toRemind.length > 2) await sleep(SEND_DELAY_MS)
    }

    return NextResponse.json({
      ok: true,
      reminded,
      failures: failures.length > 0 ? failures : undefined,
    })
  } catch (err) {
    console.error('reminders error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
