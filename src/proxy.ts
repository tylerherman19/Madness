import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { checkRateLimit } from '@/lib/rateLimit'

const ADMIN_COOKIE = 'survivor_admin'

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.get('origin')
    if (origin && origin !== req.nextUrl.origin) {
      return NextResponse.json({ error: 'Request origin is not allowed' }, { status: 403 })
    }
    const ip = req.headers.get('x-real-ip')?.trim() || req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown'
    const { allowed } = await checkRateLimit(`write:${ip}`, 120, 60)
    if (!allowed) return NextResponse.json({ error: 'Too many requests. Please wait a minute and try again.' }, { status: 429, headers: { 'Retry-After': '60' } })
  }
  if (!pathname.startsWith('/admin')) return NextResponse.next()

  if (pathname === '/admin/login') return NextResponse.next()

  const token = req.cookies.get(ADMIN_COOKIE)?.value
  if (!token) {
    return NextResponse.redirect(new URL('/admin/login', req.url))
  }

  try {
    const secret = process.env.SESSION_SECRET
    if (!secret) return NextResponse.redirect(new URL('/admin/login', req.url))
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
    // A valid signature alone is insufficient: player session tokens are signed
    // with the same secret. Require the is_admin claim set only for admin sessions.
    if (payload.is_admin !== true) {
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
