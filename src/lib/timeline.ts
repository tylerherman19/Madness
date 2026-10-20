import { normalizeRound, type PickPeriod, type TournamentRound } from './competition'
import { roundShort, weekdayDay } from './poolTheme'

// The survival timeline on the Today page: entries remaining after each pick
// day. Pure over data the page already has.

export interface TimelineColumn {
  key: string
  label: string // "R64", "Day 3", "Start"
  date: string // "Thu 18", or '' for the start column
  remaining: number | null // null for days not played yet
  state: 'done' | 'today' | 'future'
}

// The bracket calendar, used to sketch tournament days not synced yet.
const BRACKET: Array<{ round: TournamentRound; days: number; opens: number }> = [
  { round: '1st Round', days: 2, opens: 4 },
  { round: '2nd Round', days: 2, opens: 6 },
  { round: 'Sweet 16', days: 2, opens: 4 },
  { round: 'Elite 8', days: 2, opens: 6 },
  { round: 'Final Four', days: 1, opens: 6 },
  { round: 'National Championship', days: 1, opens: 1 },
]

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function nextWeekday(after: string, weekday: number): string {
  let d = addDays(after, 1)
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1)
  return d
}

// Tournament days after the last synced one, so the timeline runs to the title
// game even while later rounds are still TBD.
export function remainingBracketDays(last: Pick<PickPeriod, 'date' | 'round' | 'dayInRound'> | null): Array<{ date: string; round: TournamentRound }> {
  const round = normalizeRound(last?.round ?? null)
  if (!last || !round) return []
  const out: Array<{ date: string; round: TournamentRound }> = []
  let index = BRACKET.findIndex((r) => r.round === round)
  if (index === -1) return []
  let date = last.date
  if ((last.dayInRound ?? 1) < BRACKET[index].days) {
    date = addDays(date, 1)
    out.push({ date, round })
  }
  for (index += 1; index < BRACKET.length; index++) {
    const r = BRACKET[index]
    date = nextWeekday(date, r.opens)
    out.push({ date, round: r.round })
    for (let day = 2; day <= r.days; day++) {
      date = addDays(date, 1)
      out.push({ date, round: r.round })
    }
  }
  return out
}

export function buildTimeline({
  periods,
  currentId,
  totalEntries,
  aliveCount,
  eliminatedBySlate,
  tournament,
  maxColumns = 12,
}: {
  periods: PickPeriod[]
  currentId: string | null
  totalEntries: number
  aliveCount: number
  eliminatedBySlate: Map<number, number>
  tournament: boolean
  maxColumns?: number
}): TimelineColumn[] {
  const currentIndex = periods.findIndex((p) => p.id === currentId)
  const columns: TimelineColumn[] = []
  let remaining = totalEntries

  periods.forEach((period, index) => {
    const state = currentIndex === -1 ? 'done' : index < currentIndex ? 'done' : index === currentIndex ? 'today' : 'future'
    if (state === 'done') remaining -= eliminatedBySlate.get(period.number) ?? 0
    columns.push({
      key: period.id,
      label: (tournament && roundShort(period.round)) || `Day ${index + 1}`,
      date: weekdayDay(period.date),
      remaining: state === 'done' ? remaining : state === 'today' ? aliveCount : null,
      state,
    })
  })

  if (tournament) {
    for (const extra of remainingBracketDays(periods.at(-1) ?? null)) {
      columns.push({ key: extra.date, label: roundShort(extra.round) ?? '', date: weekdayDay(extra.date), remaining: null, state: 'future' })
    }
  }

  // A regular season has far more days than fit; keep the recent ones, today
  // and the next few.
  let visible = columns
  if (columns.length > maxColumns) {
    const anchor = currentIndex === -1 ? columns.length - 1 : currentIndex
    const end = Math.min(columns.length, Math.max(anchor + 4, maxColumns))
    visible = columns.slice(Math.max(0, end - maxColumns), end)
  }

  const startRemaining = visible[0] === columns[0] ? totalEntries : null
  return [
    ...(startRemaining !== null ? [{ key: 'start', label: 'Start', date: '', remaining: totalEntries, state: 'done' as const }] : []),
    ...visible,
  ]
}
