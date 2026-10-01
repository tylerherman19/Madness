// Which game day a tip belongs to.
//
// A game day runs from 6:00 AM to 5:59 AM Central rather than midnight to
// midnight. A late West Coast tip (10 PM Pacific is midnight Central) or a
// Hawaii game belongs to the evening it is played in. Filed by calendar date
// it landed on the next day's slate instead and, as that day's earliest tip,
// locked the whole next day at midnight — before the 6 AM advance had even
// made it active, so auto-assign then handed everyone a team.
//
// The boundary matches the 6 AM advance, so the day a game is filed under is
// always the day that is active while it is played.
//
// Pure: imported by the ESPN sync, the manual schedule form, and tests.

export const GAME_DAY_START_HOUR = 6

const CENTRAL_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})

// YYYY-MM-DD of the game day a tip at `tipIso` belongs to.
export function gameDayOf(tipIso: string): string {
  const parts: Record<string, string> = {}
  for (const part of CENTRAL_PARTS.formatToParts(new Date(tipIso))) parts[part.type] = part.value
  const beforeDayStarts = Number(parts.hour) < GAME_DAY_START_HOUR
  // Date.UTC normalises day 0 to the last day of the previous month, so the
  // step back crosses month and year ends on its own.
  const day = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - (beforeDayStarts ? 1 : 0))
  )
  return day.toISOString().slice(0, 10)
}
