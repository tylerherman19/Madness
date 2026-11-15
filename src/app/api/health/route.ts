import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// A read-only check for external uptime monitoring; never expose database errors or credentials.
export async function GET() {
  try {
    const { error } = await supabase.from('slates').select('id').limit(1).abortSignal(AbortSignal.timeout(5000))
    // The short commit of the running build (public repository; no secret) so a
    // release can be confirmed on the production domain itself.
    if (!error) return NextResponse.json({ status: 'ok', revision: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { /* Missing configuration, connection failures, and timeouts are unhealthy. */ }
  return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}
