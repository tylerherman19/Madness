import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { checkRateLimit } from '@/lib/rateLimit'
import { firstExceeded, writeLimits } from '@/lib/rateLimitPolicy'
import { sessionSecretKey } from '@/lib/sessionSecret'

const ADMIN_COOKIE = 'survivor_admin'
const SESSION_COOKIE = 'survivor_session'
const audience = () => `madness:${process.env.VERCEL_ENV ?? 'local'}`

// Identifies a signed-in player for rate limiting only. Signature, issuer,
// audience and expiry are checked; revocation is left to the route, so a
// revoked-but-unexpired cookie at most keeps its own personal budget.
async function signedInPlayer(token: string | undefined): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, sessionSecretKey(), { algorithms: ['HS256'], issuer: 'madness', audience: audience() })
    return payload.purpose === 'player' && typeof payload.player_id === 'string' ? payload.player_id : null
  } catch {
    return null
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/webhooks/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.get('origin')
    if (origin && origin !== `${req.nextUrl.protocol}//${req.headers.get('host') ?? req.nextUrl.host}`) {
      return NextResponse.json({ error: 'Request origin is not allowed' }, { status: 403 })
    }
    const ip = req.headers.get('x-real-ip')?.trim() || req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown'
    const playerId = await signedInPlayer(req.cookies.get(SESSION_COOKIE)?.value)
    if (await firstExceeded(writeLimits(ip, playerId), checkRateLimit)) return NextResponse.json({ error: 'Too many requests. Please wait a minute and try again.' }, { status: 429, headers: { 'Retry-After': '60' } })
  }
  if (!pathname.startsWith('/admin')) return NextResponse.next()

  if (pathname === '/admin/login') return NextResponse.next()

  const token = req.cookies.get(ADMIN_COOKIE)?.value
  if (!token) {
    return NextResponse.redirect(new URL('/admin/login', req.url))
  }

  try {
    // A missing or weak secret throws here and fails closed to the login page.
    const { payload } = await jwtVerify(token, sessionSecretKey(), { algorithms: ['HS256'], issuer: 'madness', audience: audience() })
    // A valid signature alone is insufficient: player session tokens are signed
    // with the same secret. Require the is_admin claim set only for admin sessions.
    if (payload.is_admin !== true || payload.purpose !== 'admin') {
      return NextResponse.redirect(new URL('/admin/login', req.url))
    }
    return NextResponse.next()
  } catch {
    return NextResponse.redirect(new URL('/admin/login', req.url))
  }
}

export const config = {
  matcher: ['/admin/:path*', '/api/:path*'],
}
