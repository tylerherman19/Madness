export function retryDelay(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.min(attempt, 7))
}
export function centralClock(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) }
}
export function reminderWindow(deadline: Date, now: Date): '2h' | '30m' | null {
  const minutes = (deadline.getTime() - now.getTime()) / 60_000
  if (minutes > 0 && minutes <= 30) return '30m'
  if (minutes > 30 && minutes <= 120) return '2h'
  return null
}
export function operationIsStale(updatedAt: string | null, now: Date, maxMinutes: number): boolean {
  return !updatedAt || now.getTime() - new Date(updatedAt).getTime() > maxMinutes * 60_000
}

export function turnoverCaughtUp(result: { caught_up?: unknown; advanced_to?: unknown }, centralDate: string): boolean {
  // An advance to another overdue day still needs a later pass under the same
  // daily operation key. Only today's/future day, or no active day, finishes it.
  return result.caught_up === true ||
    (typeof result.advanced_to === 'string' && result.advanced_to >= centralDate)
}

export function orderRecoveryDates<T extends { slate_date: string; result_checked_at?: string | null }>(dates: T[], rotate: boolean): T[] {
 return dates.slice().sort((a,b) => (rotate ? (a.result_checked_at ? new Date(a.result_checked_at).getTime() : 0) - (b.result_checked_at ? new Date(b.result_checked_at).getTime() : 0) : 0) || a.slate_date.localeCompare(b.slate_date))
}
