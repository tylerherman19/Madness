// What the header needs to know about the visitor: who they are and where
// their entry stands on the active game day. Shared by /api/me, the pages
// that already read the session, and the client header.
export type PickState =
  | 'open' // the day is open and the entry has no pick yet
  | 'submitted' // the day is open and the entry has a pick
  | 'partial' // the day is open and the entry has some, not all, of its required picks (USE-02)
  | 'locked' // the day has locked; the entry is still alive
  | 'eliminated' // the entry is out
  | 'none' // no active game day

export interface Viewer {
  name: string | null // null when signed out
  pick?: PickState
  signupsClosed?: boolean // for the header's "Join pool" link
}

export function pickStateOf({ hasSlate, eliminated, locked, hasPick, made, required }: { hasSlate: boolean; eliminated: boolean; locked: boolean; hasPick: boolean; made?: number; required?: number }): PickState {
  if (eliminated) return 'eliminated'
  if (!hasSlate) return 'none'
  if (locked) return 'locked'
  if (hasPick && made !== undefined && required !== undefined && made < required) return 'partial'
  return hasPick ? 'submitted' : 'open'
}

// How many of the required picks for the current period are saved. In a
// shared round (two picks across the round's days) picks on any of the
// round's days count; otherwise only today's.
export function pickProgress(
  picks: { slateId: string }[],
  currentId: string | null,
  periods: { id: string; round: string | null }[],
  quotaFor: (round: string | null) => number | null
): { made: number; required: number } {
  const current = periods.find((period) => period.id === currentId) ?? null
  const quota = current ? quotaFor(current.round) : null
  const ids = new Set(quota ? periods.filter((period) => period.round === current!.round).map((period) => period.id) : currentId ? [currentId] : [])
  return { made: picks.filter((pick) => ids.has(pick.slateId)).length, required: quota ?? 1 }
}
