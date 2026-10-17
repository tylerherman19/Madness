import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function withOperation<T>(db: SupabaseClient, key: string, work: () => Promise<{ done: boolean; value: T }>) {
  const { data: token, error } = await db.rpc('claim_operation', { p_key: key, p_seconds: 240 })
  if (error) throw error
  if (!token) return { claimed: false as const }
  try {
    const result = await work()
    const { data: finished, error: finishError } = await db.rpc('finish_operation', { p_key: key, p_token: token, p_done: result.done })
    if (finishError || !finished) throw finishError ?? new Error('Operation lease expired')
    return { claimed: true as const, ...result }
  } catch (error) {
    await db.rpc('finish_operation', { p_key: key, p_token: token, p_done: false, p_error: 'Operation failed' })
    throw error
  }
}
