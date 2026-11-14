// Is the active pick day older than the day being played right now?
// Pure: the caller passes the clock. Central time, with the 3 AM turnover in mind.

const TURNOVER_HOUR = 3
// The nightly job runs every minute from 3 AM; give it an hour before calling the day stale.
const GRACE_HOURS = 1

export function centralDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${p.year}-${p.month}-${p.day}`
}

// The calendar day the pool should be on: today's Central date once the turnover has had time to run,
// yesterday's before that.
export function expectedPlayingDate(now: Date): string {
  return centralDate(new Date(now.getTime() - (TURNOVER_HOUR + GRACE_HOURS) * 3_600_000))
}

export interface StaleDay { stale: boolean; activeDate: string | null; expectedDate: string; daysBehind: number }

export function staleDay(activeDate: string | null | undefined, now: Date): StaleDay {
  const expectedDate = expectedPlayingDate(now)
  if (!activeDate) return { stale: false, activeDate: null, expectedDate, daysBehind: 0 }
  const daysBehind = Math.round((Date.parse(`${expectedDate}T12:00:00Z`) - Date.parse(`${activeDate}T12:00:00Z`)) / 86_400_000)
  return { stale: daysBehind > 0, activeDate, expectedDate, daysBehind: Math.max(0, daysBehind) }
}

// "Thursday, November 12" from a YYYY-MM-DD date (no time zone shifting).
export function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
}
export function shortDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
}

export function centralStamp(iso: string | Date | null | undefined): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

export function relativeTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'never'
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} days ago`
}
