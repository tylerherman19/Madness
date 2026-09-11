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
// slate, or no games synced for slate 1), in which case signups stay open.
//
// Slate 1 opens Thursday night, but a player who joins Friday or Saturday can
// still make a legitimate Slate 1 pick off the Sunday slate, since
// a player who joins mid-season simply starts from the next slate.
//
// "First slate" is scoped by season_year and read off the active slate.
// Deriving it from the earliest kickoff across the whole games table instead
// would let any extra synced slate — a future slate synced early, last season's
// leftovers — silently drag the cutoff somewhere it doesn't belong.
export async function getSignupCutoff(): Promise<SignupCutoff | null> {
  try {
    const supabase = await getDb()

    const { data: activeSlate } = await supabase
      .from('slates')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()

    // Nothing active yet — the pool hasn't started, so signups stay open.
    if (!activeSlate) return null

    const seasonYear: number = activeSlate.season_year

    const { data: slates } = await supabase.from('slates').select('*').eq('season_year', seasonYear)
    if (!slates?.length) return null

    // Slate 1 of the season currently being played.
    const firstSlate = slates
      .slice()
      .sort((a: { slate_number: number }, b: { slate_number: number }) => a.slate_number - b.slate_number)[0]
    if (!firstSlate) return null

    // The slate's own cached lock instant, falling back to its first tip.
    const { data: games } = await supabase
      .from('games')
      .select('tip_time')
      .eq('slate_id', firstSlate.id)
      .order('tip_time', { ascending: true })
      .limit(1)

    const cutoff = slateDeadline(firstSlate, (games ?? []) as Game[])
    if (!cutoff) return null

    return { cutoff, seasonYear, slateNumber: firstSlate.slate_number }
  } catch {
    // No schedule synced yet — signups stay open.
    return null
  }
}

// Whether new signups are closed. Respects the sandbox's simulated clock in
// test mode, same as every other deadline check in the app.
export async function haveSignupsClosed(): Promise<boolean> {
  const anchor = await getSignupCutoff()
  if (!anchor) return false

  const now = await getEffectiveNow()
  return now >= anchor.cutoff
}
