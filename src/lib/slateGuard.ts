// Pure rules for changing the active day, shared by the preview and the routes.

export interface ActiveDayStatus {
  slateId: string
  slateDate: string
  slateNumber: number
  locked: boolean
  // Alive entries missing required picks for the active day; null when unknown.
  unpicked: number | null
  autoAssignCompleted: boolean
  pendingGames: number
  ungradedGames: number
}

// Changing the active day after lock but before auto-assignment ran would leave
// the old day's entries without a pick alive and unassigned forever.
export function assignmentGuard(status: Pick<ActiveDayStatus, 'locked' | 'unpicked' | 'autoAssignCompleted'>): { blocked: boolean; message: string | null } {
  if (status.locked && !status.autoAssignCompleted && (status.unpicked ?? 0) > 0) {
    return {
      blocked: true,
      message: `Auto-assignment has not completed for the current day and ${status.unpicked} alive ${status.unpicked === 1 ? 'entry has' : 'entries have'} no required pick. Run Auto-Assign first (or wait for it to finish), then change the day. You can change it anyway with an override and a reason.`,
    }
  }
  return { blocked: false, message: null }
}

export function validReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const reason = value.trim()
  return reason.length >= 3 && reason.length <= 500 ? reason : null
}
