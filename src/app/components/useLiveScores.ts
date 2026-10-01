'use client'

import { useSyncExternalStore } from 'react'
import type { LiveScoresResponse } from '@/app/api/live-scores/route'

// One shared poller for /api/live-scores per browser tab. The score ticker and
// the schedule board both show live scores, and each used to run its own
// timer — /schedule asked the server twice as often as it needed to. Every
// component that calls useLiveScores() now reads the same request stream.
//
// Cadence follows the games: every 30 seconds while one is live or about to
// tip, every 5 minutes otherwise, and not at all while the tab is hidden.

const FAST_MS = 30_000
const SLOW_MS = 300_000
// Poll fast from five minutes before a listed tip until it goes live, giving
// ESPN up to half an hour to flip it before falling back to the slow cadence
// (a game still "pre" long after its tip is delayed or postponed).
const TIP_LEAD_MS = 5 * 60_000
const TIP_GRACE_MS = 30 * 60_000

let latest: LiveScoresResponse | null = null
let fetchedAt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
const listeners = new Set<() => void>()

function nextDelay(data: LiveScoresResponse | null): number {
  if (!data) return SLOW_MS
  if (data.hasLiveGames) return FAST_MS
  const now = Date.now()
  let delay = SLOW_MS
  for (const game of data.games) {
    if (game.state !== 'pre' || game.timeTbd) continue
    const tip = new Date(game.kickoff).getTime()
    if (Number.isNaN(tip) || now > tip + TIP_GRACE_MS) continue
    delay = Math.min(delay, Math.max(FAST_MS, tip - TIP_LEAD_MS - now))
  }
  return delay
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer)
  timer = listeners.size > 0 ? setTimeout(poll, Math.max(0, delay)) : null
}

async function poll() {
  timer = null
  if (listeners.size === 0 || inFlight) return
  // Hidden tabs don't poll; coming back resumes (see onVisibilityChange).
  if (document.hidden) return
  inFlight = true
  try {
    const response = await fetch('/api/live-scores', { cache: 'no-store' })
    if (response.ok) {
      latest = (await response.json()) as LiveScoresResponse
      fetchedAt = Date.now()
      for (const listener of listeners) listener()
    }
  } catch {
    // Keep the last good scoreboard through a transient network failure.
  } finally {
    inFlight = false
    schedule(nextDelay(latest))
  }
}

// Fetch now if what we hold is older than the cadence allows, otherwise
// wait out the remainder.
function resume() {
  if (inFlight) return
  const remaining = nextDelay(latest) - (Date.now() - fetchedAt)
  if (remaining <= 0) {
    if (timer) clearTimeout(timer)
    void poll()
  } else {
    schedule(remaining)
  }
}

function onVisibilityChange() {
  if (!document.hidden && listeners.size > 0) resume()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    resume()
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

export function useLiveScores(): LiveScoresResponse | null {
  return useSyncExternalStore(
    subscribe,
    () => latest,
    () => null
  )
}
