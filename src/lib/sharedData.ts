import 'server-only'
import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase, sandboxSupabase } from './supabase'
import { CONTEST_TAG } from './cacheTags'
import { getTeamConferences } from './teams'
import { TEAM_DIRECTORY_URL, parseTeamDirectory, type TeamBrandDirectory } from './teamBrand'

// Reads that are the same for every visitor, cached on the server and shared.
//
// Cached functions cannot look at the request, so they take the database by
// name. Test mode never reaches the cache at all: it runs on Next.js Draft
// Mode, and Next bypasses these caches for draft-mode requests. The schema is
// part of every cache key anyway, so sandbox rows could never be served to
// production even if that changed.

export type Schema = 'public' | 'sandbox'

export function schemaOf(db: SupabaseClient): Schema {
  return db === sandboxSupabase ? 'sandbox' : 'public'
}

export function clientFor(schema: Schema): SupabaseClient {
  return schema === 'sandbox' ? sandboxSupabase : supabase
}

// ESPN's team directory is a 1.5 MB response, close to the data cache's 2 MB
// per-item limit. Only the trimmed directory (~70 KB) is cached. A failed or
// empty response throws so it is never cached; once a good copy exists, a
// failed daily refresh keeps serving it.
const loadTeamDirectory = unstable_cache(
  async (): Promise<TeamBrandDirectory> => {
    const response = await fetch(TEAM_DIRECTORY_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`ESPN team directory returned ${response.status}`)
    const directory = parseTeamDirectory(await response.json())
    if (Object.keys(directory).length === 0) throw new Error('ESPN team directory was empty')
    return directory
  },
  ['espn-team-directory-v1'],
  { revalidate: 86_400 }
)

// Names, logos and colors for every team ESPN knows. Empty when ESPN is
// unreachable and nothing is cached yet: every team then shows its
// abbreviation on its own color.
export async function getTeamBrandDirectory(): Promise<TeamBrandDirectory> {
  try {
    return await loadTeamDirectory()
  } catch {
    return {}
  }
}

const loadConferences = unstable_cache(
  async (schema: Schema) => getTeamConferences(clientFor(schema)),
  ['team-conferences-v1'],
  { tags: [CONTEST_TAG], revalidate: 3600 }
)

// Conference per team, for grouping regular-season games. Display only.
export async function getCachedTeamConferences(db: SupabaseClient): Promise<Record<string, string>> {
  try {
    return await loadConferences(schemaOf(db))
  } catch {
    return {}
  }
}
