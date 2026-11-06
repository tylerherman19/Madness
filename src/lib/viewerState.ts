// What the header needs to know about the visitor: who they are and where
// their entry stands on the active game day. Shared by /api/me, the pages
// that already read the session, and the client header.
export type PickState =
  | 'open' // the day is open and the entry has no pick yet
  | 'submitted' // the day is open and the entry has a pick
  | 'locked' // the day has locked; the entry is still alive
  | 'eliminated' // the entry is out
  | 'none' // no active game day

export interface Viewer {
  name: string | null // null when signed out
  pick?: PickState
  signupsClosed?: boolean // for the header's "Join pool" link
}

export function pickStateOf({ hasSlate, eliminated, locked, hasPick }: { hasSlate: boolean; eliminated: boolean; locked: boolean; hasPick: boolean }): PickState {
  if (eliminated) return 'eliminated'
  if (!hasSlate) return 'none'
  if (locked) return 'locked'
  return hasPick ? 'submitted' : 'open'
}
