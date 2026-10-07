import 'server-only'
import { getDb, getEffectiveNow } from './testMode'
import { slateDeadline } from './deadline'
import type { Game } from '@/types'

export interface SignupCutoff {
  cutoff: Date
  seasonYear: number
  slateNumber: number
}

// The instant new signups close: the lock time of the season's first slate. Null means there is nothing to anchor to yet (no active
// slate), in which case signups stay open. Missing deadlines fail closed.
//
// "First slate" is scoped by season_year and read off the active slate.
// Deriving it from the earliest kickoff across the whole games table instead
// would let any extra synced slate — a future slate synced early, last season's
// leftovers — silently drag the cutoff somewhere it doesn't belong.
export async function getSignupCutoff(): Promise<SignupCutoff | null> {
  const supabase = await getDb()

  const { data: activeSlate, error: activeError } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .maybeSingle()

  if (activeError) throw activeError
  // Nothing active yet — the pool hasn't started, so signups stay open.
  if (!activeSlate) return null

  const seasonYear: number = activeSlate.season_year

  const { data: slates, error: slatesError } = await supabase.from('slates').select('*').eq('season_year', seasonYear)
  if (slatesError) throw slatesError
  if (!slates?.length) return null

  // Slate 1 of the season currently being played.
  const firstSlate = slates
    .slice()
    .sort((a: { slate_number: number }, b: { slate_number: number }) => a.slate_number - b.slate_number)[0]
  if (!firstSlate) return null

  // The slate's own cached lock instant, falling back to its first tip.
  const { data: games, error: gamesError } = await supabase
    .from('games')
    .select('tip_time, time_tbd')
    .eq('slate_id', firstSlate.id)
    .order('tip_time', { ascending: true })

  if (gamesError) throw gamesError
  const cutoff = slateDeadline(firstSlate, (games ?? []) as Game[])
  if (!cutoff) throw new Error('Registration deadline is unavailable. Please contact support.')

  return { cutoff, seasonYear, slateNumber: firstSlate.slate_number }
}

// Whether new signups are closed. Respects the sandbox's simulated clock in
// test mode, same as every other deadline check in the app.
export async function haveSignupsClosed(strict = false): Promise<boolean> {
  let anchor: SignupCutoff | null
  try {
    anchor = await getSignupCutoff()
  } catch (error) {
    if (strict) throw error
    // Public/pre-rendered pages close registration on missing data. Mutations
    // use strict mode and report the failure rather than accepting an entry.
    return true
  }
  if (!anchor) return false

  const now = await getEffectiveNow()
  return now >= anchor.cutoff
}
