import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { isTestMode, createTestInviteToken } from '@/lib/testMode'
import { sandboxSupabase } from '@/lib/supabase'
import TestingPanel from './TestingPanel'

export interface SandboxGame {
  id: string
  home_team: string
  away_team: string
  tip_time: string
  home_score: number | null
  away_score: number | null
  result: string
}

export interface SandboxSnapshot {
  ok: boolean
  error: string | null
  players: { id: string; full_name: string; email: string; status: string }[]
  activeSlate: { id: string; slate_number: number; season_year: number } | null
  gameCount: number
  pickCount: number
  games: SandboxGame[]
  simulatedNow: string | null
  effectiveNow: string
}

async function getSandboxSnapshot(): Promise<SandboxSnapshot> {
  const empty = { players: [], activeSlate: null, gameCount: 0, pickCount: 0, games: [], simulatedNow: null }
  try {
    const { data: players, error } = await sandboxSupabase
      .from('players')
      .select('id, full_name, email, status')
      .order('full_name')
    // Surface schema-setup problems (missing migration / unexposed schema)
    // right in the panel instead of failing silently everywhere.
    if (error) return { ok: false, error: error.message, effectiveNow: new Date().toISOString(), ...empty }

    const [{ data: slate }, { count: gameCount }, { count: pickCount }, { data: clockRow }] = await Promise.all([
      sandboxSupabase.from('slates').select('id, slate_number, season_year').eq('is_active', true).single(),
      sandboxSupabase.from('games').select('id', { count: 'exact', head: true }),
      sandboxSupabase.from('picks').select('id', { count: 'exact', head: true }),
      sandboxSupabase.from('clock').select('simulated_now').eq('id', true).single(),
    ])

    const { data: games } = slate
      ? await sandboxSupabase
          .from('games')
          .select('id, home_team, away_team, tip_time, home_score, away_score, result')
          .eq('slate_id', slate.id)
          .order('tip_time')
      : { data: [] }

    return {
      ok: true,
      error: null,
      players: players || [],
      activeSlate: slate ?? null,
      gameCount: gameCount ?? 0,
      pickCount: pickCount ?? 0,
      games: games ?? [],
      simulatedNow: clockRow?.simulated_now ?? null,
      effectiveNow: clockRow?.simulated_now ?? new Date().toISOString(),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sandbox unreachable', effectiveNow: new Date().toISOString(), ...empty }
  }
}

export default async function TestingPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')

  const testMode = await isTestMode()
  const snapshot = await getSandboxSnapshot()
  const inviteToken = testMode ? await createTestInviteToken() : null

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Testing Mode</h1>
        <p className="text-slate-400 mt-1">
          A black-box sandbox: separate players, schedule, picks, and results living in their own
          database schema. While enabled, this browser sees the entire site — picks, standings,
          grading, auto-assign, everything — running against sandbox data. Other visitors are unaffected.
        </p>
      </div>
      <TestingPanel testMode={testMode} snapshot={snapshot} inviteToken={inviteToken} />
    </div>
  )
}
