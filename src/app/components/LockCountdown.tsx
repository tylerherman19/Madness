'use client'

import { useEffect, useState } from 'react'

// Time left until the slate locks: "2:14:36". Turns amber in the last hour
// (when given a class for it) and reads "Locked" once the deadline passes.
export default function LockCountdown({ deadline, className, soonClassName }: { deadline: string; className?: string; soonClassName?: string }) {
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, new Date(deadline).getTime() - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [deadline])
  if (left === null) return <span className={className}>&nbsp;</span>
  if (left === 0) return <span className={className}>Locked</span>
  const days = Math.floor(left / 864e5)
  const h = Math.floor((left % 864e5) / 36e5)
  const m = Math.floor((left % 36e5) / 6e4)
  const sec = Math.floor((left % 6e4) / 1e3)
  const text = (days > 0 ? `${days}d ` : '') + `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return <span className={`${className ?? ''} ${left < 36e5 && soonClassName ? soonClassName : ''}`} role="timer">{text}</span>
}
