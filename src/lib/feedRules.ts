import { NextResponse } from 'next/server'

// Rules shared by the two public live feeds (/api/sweat, /api/live-scores).

// Seconds the CDN may keep a feed response. Before the reveal the copy may
// not outlive the stored lock, so a board cached a moment before first tip
// stops hiding picks on time (give or take the CDN's short stale window).
// After the reveal, or with no lock yet, the schedule-based figure stands.
export function revealCacheSeconds(cdn: number, revealed: boolean, deadline: Date | null, now: Date): number {
  if (revealed || !deadline) return cdn
  return Math.max(1, Math.min(cdn, Math.floor((deadline.getTime() - now.getTime()) / 1000)))
}

// Test-mode browsers poll `?sandbox=1`, a URL the CDN never stores. Only a
// browser that really is in test mode may use it: anyone else is sent to the
// shared URL, so the parameter cannot be used to skip the CDN and reach the
// database on every request. The same goes for every other query string. The redirect itself is never stored either — a
// cached one would bounce a real tester to the production copy.
export function sandboxRedirect(url: URL, testMode: boolean): NextResponse | null {
  // Neither feed reads its query string, so outside test mode any query at all
  // (not just ?sandbox) is the shared URL's answer under another name. The CDN
  // would store each distinct query separately, which makes a changing
  // `?x=<random>` a way to reach the database on every request.
  if (testMode || url.search === '') return null
  const shared = new URL(url.toString())
  shared.search = ''
  return NextResponse.redirect(shared, { status: 307, headers: { 'Cache-Control': 'private, no-store' } })
}
