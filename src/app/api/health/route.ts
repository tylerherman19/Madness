import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// A read-only check for external uptime monitoring; never expose database errors or credentials.
export async function GET() {
  try {
    const { error } = await supabase.from('slates').select('id').limit(1).abortSignal(AbortSignal.timeout(5000))
    if (!error) return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { /* Missing configuration, connection failures, and timeouts are unhealthy. */ }
  return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}
