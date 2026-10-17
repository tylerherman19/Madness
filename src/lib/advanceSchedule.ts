const CENTRAL_TZ = 'America/Chicago'

// Two UTC cron entries cover CST/CDT; only the local 3 AM run may advance.
// Use the real clock for scheduled jobs, independent of the sandbox clock.
export function isAdvanceWindow(now: Date): boolean {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now)) === 3
}
