const CENTRAL_TZ = 'America/Chicago'

// Turnover starts at 3 AM Central and can catch up after a delayed job or feed.
// Use the real clock for scheduled jobs, independent of the sandbox clock.
export function isAdvanceWindow(now: Date): boolean {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now)) >= 3
}
