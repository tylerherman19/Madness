// The next day opens from ESPN's live final, but the database accepts the pick
// only once that result is stored by the results job (REL-03).
export const EARLY_PICK_PENDING = 'Your win is still being confirmed. Your pick for the next game day can be saved in a minute or two — nothing was saved yet.'

export function pickWriteError(error: { code?: string; message: string }): { status: number; message: string } | null {
  if (error.code === 'PGRST116' || error.code === '23505' || error.code === '40001' || error.code === '40P01') {
    return { status: 409, message: 'Your pick was saved or changed in another request. Refresh to see the saved pick before trying again.' }
  }
  if (error.code !== 'P0001') return null
  if (/Both Elite Eight picks must be submitted together/i.test(error.message)) return { status: 409, message: 'Submit both Elite Eight picks together.' }
  if (/Pick period is not open/i.test(error.message)) return { status: 409, message: EARLY_PICK_PENDING }
  if (/Picks are locked|deadline is unavailable/i.test(error.message)) return { status: 409, message: 'The pick deadline has passed or is unavailable. Refresh to see your final pick.' }
  if (/outside the active contest/i.test(error.message)) return { status: 409, message: 'The active contest changed. Refresh before making a pick.' }
  if (/Pick quota reached/i.test(error.message)) return { status: 409, message: 'Your required picks are already saved. Refresh to see them.' }
  if (/Team already used/i.test(error.message)) return { status: 409, message: 'You already used this team. Refresh and choose another team.' }
  if (/no entries left alive/i.test(error.message)) return { status: 409, message: 'No entries are alive, so picks are closed.' }
  if (/previous pick lost|You are eliminated/i.test(error.message)) return { status: 403, message: 'Your entry is no longer eligible. Refresh to see its status.' }
  if (/This team is unavailable/i.test(error.message)) return { status: 409, message: 'This team is no longer available. Refresh the game day.' }
  return null
}
