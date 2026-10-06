import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Every database call gets a deadline. Without one a stalled connection holds
// the serverless function (and the user's spinner) until the platform kills it.
const DB_TIMEOUT_MS = 15_000

const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(DB_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}

// Lazy singleton per schema — only creates the client when first called, so
// build-time evaluation of this module doesn't fail without env vars set.
function lazySupabase(schema: string): SupabaseClient {
  let client: SupabaseClient | null = null
  return new Proxy({} as SupabaseClient, {
    get(_target, prop) {
      if (!client) {
        const url = process.env.SUPABASE_URL
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
        // Cast away the schema-name generic: both schemas expose identical tables
        client = createClient(url, key, {
          auth: { persistSession: false },
          db: { schema },
          global: { fetch: fetchWithTimeout },
        }) as unknown as SupabaseClient
      }
      const value = (client as unknown as Record<string, unknown>)[prop as string]
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

// Production data (public schema). Import this directly only for things that
// must always hit production (rate limits, cron entry points); everything
// request-scoped should go through getDb() in lib/testMode.ts instead.
export const supabase = lazySupabase('public')

// Testing sandbox — a mirrored table set in the `sandbox` schema
// (supabase/migrations/004_testing_sandbox.sql). Only ever served to browsers
// carrying the signed test-mode cookie.
export const sandboxSupabase = lazySupabase('sandbox')
