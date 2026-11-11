// Rate-limit keys and budgets, kept free of Next/Supabase imports so the
// shared-network scenarios can be unit tested against the local limiter.
//
// Shared networks (campus Wi-Fi, office NAT, mobile carrier NAT) put many
// honest people behind one address. Account-aware keys stop one abusive client
// or one targeted account first, so they cannot use up the address-wide ceiling
// that everyone else on that network depends on. The per-address ceilings stay
// as the outer safeguard.

export type Limit = { key: string; max: number; windowSeconds: number }
export type Check = (key: string, max: number, windowSeconds: number) => Promise<{ allowed: boolean }> | { allowed: boolean }

// Limits are checked in order and evaluation stops at the first refusal. The
// counter behind a refused limit still increments, but later (wider) limits are
// not touched, so a throttled client cannot keep draining a shared budget.
export async function firstExceeded(limits: Limit[], check: Check): Promise<Limit | null> {
  for (const limit of limits) {
    if (!(await check(limit.key, limit.max, limit.windowSeconds)).allowed) return limit
  }
  return null
}

const MINUTE = 60
const FIFTEEN_MINUTES = 15 * 60
const HOUR = 60 * 60

// Every non-GET API request passes the proxy. A verified signed-in player gets
// a personal budget; anonymous writes (login, signup, reset) share a smaller
// per-address budget so a flood of them cannot crowd out signed-in pick saves.
export function writeLimits(ip: string, playerId: string | null): Limit[] {
  return [
    playerId
      ? { key: `write-player:${playerId}`, max: 120, windowSeconds: MINUTE }
      : { key: `write-anon:${ip}`, max: 600, windowSeconds: MINUTE },
    { key: `write:${ip}`, max: 1200, windowSeconds: MINUTE },
  ]
}

// accountKey is a hash of the normalised email, never the email itself.
// 1. one account from one address (typos, one guesser): 10 per 15 minutes;
// 2. one account from anywhere (distributed guessing): 30 per 15 minutes;
// 3. the whole address: 1,000 per 15 minutes (unchanged outer ceiling).
// Trade-off: rule 2 lets someone who knows a participant's email delay that
// participant's sign-in for up to 15 minutes; it never reveals the password.
export function loginLimits(accountKey: string, ip: string): Limit[] {
  return [
    { key: `login-account-network:${accountKey}:${ip}`, max: 10, windowSeconds: FIFTEEN_MINUTES },
    { key: `login-account:${accountKey}`, max: 30, windowSeconds: FIFTEEN_MINUTES },
    { key: `login-network:${ip}`, max: 1000, windowSeconds: FIFTEEN_MINUTES },
  ]
}

// Reset-link use. tokenKey is a hash of the submitted token. Links carry 256
// random bits, so the per-link budget only stops replay noise; the per-address
// budget bounds guessing and audit volume.
// A malformed token (tokenKey null) only counts against the address.
export function resetLinkLimits(tokenKey: string | null, ip: string): Limit[] {
  return [
    ...(tokenKey ? [{ key: `reset-link:${tokenKey}`, max: 5, windowSeconds: HOUR }] : []),
    { key: `reset-password:${ip}`, max: 30, windowSeconds: HOUR },
  ]
}
