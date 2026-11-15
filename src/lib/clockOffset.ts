// USE-04: how far to move this device's clock toward the server's when
// counting down to the lock. Never negative: a stale server timestamp (slow
// hydration, a re-mount on back navigation, a cached page) must never make
// the countdown show more time than is left. A device clock that runs slow is
// still corrected.
export function countdownOffsetMs(serverNow: string | undefined, deviceNow: number): number {
  if (!serverNow) return 0
  const server = new Date(serverNow).getTime()
  return Number.isFinite(server) ? Math.max(0, server - deviceNow) : 0
}
