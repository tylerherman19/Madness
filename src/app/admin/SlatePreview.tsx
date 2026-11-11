import type { ActiveDayStatus } from '@/lib/slateGuard'

export interface Preview {
  from: string | null
  to: string | null
  status: ActiveDayStatus | null
  blocked: boolean
  message: string | null
}

// What will happen: shared by "Advance" and "Set active day".
export default function SlatePreview({ preview, toFallback }: { preview: Preview; toFallback: string }) {
  const s = preview.status
  return (
    <dl className="text-xs text-ink space-y-1" aria-label="What will happen">
      <div><dt className="inline font-semibold">From: </dt><dd className="inline">{preview.from ?? 'no active day'}</dd></div>
      <div><dt className="inline font-semibold">To: </dt><dd className="inline">{preview.to ?? toFallback}</dd></div>
      {s && (
        <>
          <div><dt className="inline font-semibold">Alive entries with no pick for the current day: </dt><dd className="inline">{s.unpicked ?? 'unknown'}</dd></div>
          <div><dt className="inline font-semibold">Current day games: </dt><dd className="inline">{s.pendingGames} pending, {s.ungradedGames} final but not graded</dd></div>
          <div><dt className="inline font-semibold">Auto-assignment: </dt><dd className="inline">{s.autoAssignCompleted ? 'completed' : s.locked ? 'not completed (day is locked)' : 'not needed yet (day has not locked)'}</dd></div>
        </>
      )}
    </dl>
  )
}
