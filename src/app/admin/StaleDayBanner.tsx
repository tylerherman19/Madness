import JumpToCurrentDay from './JumpToCurrentDay'
import { longDate } from '@/lib/staleDay'

// Shown on the admin overview and the System status page whenever the active day is behind.
export default function StaleDayBanner({ activeDate, expectedDate, daysBehind, level = 2 }: { level?: 2 | 3; activeDate: string; expectedDate: string; daysBehind: number }) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <section aria-labelledby="stale-day-title" role="alert" className="rounded-xl border border-warning/40 bg-surface p-4 space-y-3">
      <Heading id="stale-day-title" className="text-base font-semibold text-warning">The pool is stuck on an old day</Heading>
      <p className="text-sm text-ink">
        Players are still being shown {longDate(activeDate)}, which is {daysBehind} day{daysBehind === 1 ? '' : 's'} behind
        (today is {longDate(expectedDate)}, Central time). The automatic night-time move to the next day could not finish.
      </p>
      <JumpToCurrentDay activeDate={activeDate} />
    </section>
  )
}
