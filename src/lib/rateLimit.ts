import { localRateLimit } from './localRateLimit'
import { supabase } from './supabase'
import { headers } from 'next/headers'

export async function getIP(): Promise<string> {
  const h = await headers()
  // x-real-ip is set by Vercel to the actual client IP and cannot be spoofed.
  // x-forwarded-for can be manipulated by adding a fake first entry.
  const realIp = h.get('x-real-ip')
  if (realIp) return realIp.trim()
  // Fallback: use the LAST entry in x-forwarded-for (added by Vercel edge, not user-controlled).
  const forwarded = h.get('x-forwarded-for')
  if (forwarded) {
    const parts = forwarded.split(',')
    return parts[parts.length - 1].trim()
  }
  return 'unknown'
}

// Rate limits always live in production (public schema) — a sandbox browser
// must not get a fresh budget for login/signup attempts.
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean }> {
  try {
    // One atomic round trip (migration 006). A bounded local budget remains
    // available if the function is missing or the database times out.
    const { data, error } = await supabase.rpc('bump_rate_limit', {
      p_key: key,
      p_max: maxRequests,
      p_window_seconds: windowSeconds,
    }).abortSignal(AbortSignal.timeout(3000))
    if (!error) return { allowed: data === true }
  } catch {
    // The distributed limiter is unavailable. Retain a bounded per-instance budget.
  }
  return { allowed: localRateLimit(key, maxRequests, windowSeconds) }
}
