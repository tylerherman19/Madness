import type { Instrumentation } from 'next'

// Catches what route handlers don't: uncaught errors while rendering pages,
// in server actions, or in a handler with no try/catch of its own. Handled
// failures are reported at their call sites via lib/alerts.ts.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Test-mode browsers run against the sandbox; their crashes shouldn't land
  // in production's trail or text anyone.
  const cookie = request.headers.cookie
  const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : cookie ?? ''
  if (cookieHeader.includes('survivor_test_mode=')) return

  const { reportFailure } = await import('./lib/alerts')
  const { supabase } = await import('./lib/supabase')
  const path = request.path.split('?')[0]
  const error = err as Error & { digest?: string }
  await reportFailure(supabase, {
    kind: 'server-error',
    source: `${context.routeType}:${context.routePath}`,
    message: `Crash on ${request.method} ${path}`,
    error,
    details: { digest: error.digest, route_type: context.routeType },
  })
}
