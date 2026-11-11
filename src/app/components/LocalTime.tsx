'use client'

import { useSyncExternalStore } from 'react'
import { formatClock } from '@/lib/deadline'

const subscribe = () => () => {}

function detectZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

// The viewer's IANA zone, or null on the server, during hydration and when it
// cannot be detected. React renders the null (Central) version first and then
// swaps, so server and client markup always agree.
export function useViewerTimeZone(): string | null {
  return useSyncExternalStore(subscribe, detectZone, () => null)
}

// A deadline or tip time in the viewer's own zone, with a short zone label
// ("5:00 PM CST"). Server render and failed detection show Central. Display
// only: the server and database decide when a slate locks.
export default function LocalTime({ iso, zone = true }: { iso: string | null | undefined; zone?: boolean }) {
  const timeZone = useViewerTimeZone()
  const text = formatClock(iso, timeZone, zone)
  if (!iso || text === 'TBD') return <>TBD</>
  return <time dateTime={new Date(iso).toISOString()}>{text}</time>
}
