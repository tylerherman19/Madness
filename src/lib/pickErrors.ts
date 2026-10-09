export function pickWriteError(error: { code?: string; message: string }): { status: number; message: string } | null {
  if (error.code === 'PGRST116' || error.code === '23505' || error.code === '40001' || error.code === '40P01') {
    return { status: 409, message: 'Your pick was saved or changed in another request. Refresh to see the saved pick before trying again.' }
  }
  if (error.code !== 'P0001') return null
  if (/Picks are locked|deadline is unavailable/i.test(error.message)) return { status: 409, message: 'The pick deadline has passed or is unavailable. Refresh to see your final pick.' }
  if (/outside the active contest/i.test(error.message)) return { status: 409, message: 'The active contest changed. Refresh before making a pick.' }
  if (/Pick quota reached/i.test(error.message)) return { status: 409, message: 'Your required picks are already saved. Refresh to see them.' }
  if (/Team already used/i.test(error.message)) return { status: 409, message: 'You already used this team. Refresh and choose another team.' }
  if (/previous pick lost|You are eliminated/i.test(error.message)) return { status: 403, message: 'Your entry is no longer eligible. Refresh to see its status.' }
  if (/This team is unavailable/i.test(error.message)) return { status: 409, message: 'This team is no longer available. Refresh the game day.' }
  return null
}
