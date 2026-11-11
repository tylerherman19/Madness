import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assignmentGuard, type ActiveDayStatus } from './slateGuard'

// Reads the active day's lock, assignment and result state. Server-side and
// authoritative: routes call this themselves rather than trusting the client.
export async function getActiveDayStatus(db: SupabaseClient, now: Date): Promise<ActiveDayStatus | null> {
  const { data: slate, error } = await db
    .from('slates')
    .select('id, slate_number, slate_date, locks_at, auto_assign_completed_at')
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  if (!slate) return null
  const { data: requirement } = await db.rpc('active_pick_requirement')
  const deadlineIso = (requirement as { deadline?: string | null } | null)?.deadline ?? slate.locks_at
  const { data: counts } = await db.rpc('contest_counts')
  const unpicked = (counts as { unpicked?: number } | null)?.unpicked
  const { data: games, error: gamesError } = await db.from('games').select('result, graded_at').eq('slate_id', slate.id)
  if (gamesError) throw gamesError
  const rows = (games ?? []) as { result: string; graded_at: string | null }[]
  return {
    slateId: slate.id,
    slateDate: slate.slate_date,
    slateNumber: slate.slate_number,
    locked: Boolean(deadlineIso) && new Date(deadlineIso as string).getTime() <= now.getTime(),
    unpicked: typeof unpicked === 'number' ? unpicked : null,
    autoAssignCompleted: Boolean(slate.auto_assign_completed_at),
    pendingGames: rows.filter((g) => g.result === 'pending').length,
    ungradedGames: rows.filter((g) => g.result !== 'pending' && g.result !== 'void' && !g.graded_at).length,
  }
}

export { assignmentGuard }
