// Timing for the two live feeds, the score ticker and the sweat board. Shared
// by the routes (how long the CDN may keep its copy) and by the browser (how
// long to wait before asking again), so the two stay in step.
//
//   * A game in progress, or one past its tip that the feed hasn't marked
//     live yet: the CDN copy lasts 10 seconds (ESPN itself only updates about
//     that often) and pages ask every 15.
//   * Before a tip: the copy lasts up to a minute (30 seconds for the sweat
//     board, whose "who has picked" list changes as people pick), but never
//     past the next tip, so the switch to live scores and the pick reveal at
//     the first tip happen on time. Pages ask again just after that tip.
//   * Nothing left to play: 5 minutes.

export const LIVE_CDN_SECONDS = 10
export const IDLE_CDN_SECONDS = 300
export const LIVE_POLL_MS = 15_000
export const IDLE_POLL_MS = 300_000
// Before the first successful response, try again within a minute.
export const RETRY_MS = 60_000

export interface ScheduledGame {
  state: 'pre' | 'in' | 'post' | string
  kickoff: string
  timeTbd?: boolean
}

type Next = { live: true } | { live: false; nextTip: number | null }

function lookAhead(games: ScheduledGame[], hasLive: boolean, now: number): Next {
  if (hasLive) return { live: true }
  let nextTip: number | null = null
  for (const game of games) {
    if (game.state !== 'pre' || game.timeTbd) continue
    const tip = new Date(game.kickoff).getTime()
    if (isNaN(tip)) continue
    if (tip <= now) return { live: true }
    if (nextTip === null || tip < nextTip) nextTip = tip
  }
  return { live: false, nextTip }
}

// Seconds the CDN may serve one copy of a feed response.
export function cdnSeconds(games: ScheduledGame[], hasLive: boolean, beforeTipSeconds: number, now = Date.now()): number {
  const next = lookAhead(games, hasLive, now)
  if (next.live) return LIVE_CDN_SECONDS
  if (next.nextTip === null) return IDLE_CDN_SECONDS
  return Math.max(1, Math.min(beforeTipSeconds, Math.floor((next.nextTip - now) / 1000)))
}

// Milliseconds a page waits before asking the feed again.
export function nextPollMs(games: ScheduledGame[], hasLive: boolean, now = Date.now()): number {
  const next = lookAhead(games, hasLive, now)
  if (next.live) return LIVE_POLL_MS
  if (next.nextTip === null) return IDLE_POLL_MS
  // A couple of seconds past the tip, once the CDN copy has turned over.
  return Math.max(LIVE_POLL_MS, Math.min(IDLE_POLL_MS, next.nextTip - now + 2_000))
}

// The Cache-Control header for a feed response. Browsers keep their copy for
// 5 seconds, so moving between pages reuses it; the CDN keeps its own for
// `cdn` seconds and may serve it a little longer while it fetches a new one.
// Test-mode responses are never stored anywhere.
export function feedCacheControl(cdn: number | null): string {
  if (cdn === null) return 'private, no-store'
  return `public, max-age=5, s-maxage=${cdn}, stale-while-revalidate=${cdn === LIVE_CDN_SECONDS ? 5 : 30}`
}
