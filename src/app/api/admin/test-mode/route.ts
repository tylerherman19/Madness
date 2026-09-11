import { NextRequest, NextResponse } from 'next/server'
import { draftMode } from 'next/headers'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { requireAdmin } from '@/lib/api'
import { isTestMode, setTestModeCookie, clearTestModeCookie } from '@/lib/testMode'
import { sandboxSupabase } from '@/lib/supabase'
import { hashPin } from '@/lib/pin'
import { gradeSlatePicks } from '@/lib/grading'
import type { Game } from '@/types'

const CHICAGO_TZ = 'America/Chicago'

// Every seeded test user logs in with this PIN (sandbox-only accounts).
const TEST_USER_PIN = '1234'

// One day of games, tomorrow, spread across an evening. The whole slate
// locks at the first tip (6:00 PM CT here), so the sandbox clock can be
// parked before it to test picking and after it to test the lock,
// auto-assign and grading. 12 distinct teams, so seeded players have plenty
// of untouched teams for multi-day testing.
const TEST_SLATE = [
  { away: 'DUKE', home: 'UNC', hour: 18, minute: 0 },
  { away: 'MICH', home: 'OSU', hour: 18, minute: 30 },
  { away: 'KU', home: 'BAY', hour: 20, minute: 0 },
  { away: 'UK', home: 'FLA', hour: 20, minute: 30 },
  { away: 'UCLA', home: 'ARIZ', hour: 21, minute: 0 },
  { away: 'GONZ', home: 'CREI', hour: 21, minute: 30 },
] as const

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await req.json()
    const action = body?.action

    if (action === 'enable') {
      const draft = await draftMode()
      draft.enable()
      await setTestModeCookie()
      return NextResponse.json({ ok: true, testMode: true })
    }

    if (action === 'disable') {
      const draft = await draftMode()
      draft.disable()
      await clearTestModeCookie()
      return NextResponse.json({ ok: true, testMode: false })
    }

    // seed / reset mutate the sandbox — refuse unless this browser is
    // actually in test mode, so a stray call can never look like it worked
    // while the admin is staring at production data.
    if (!(await isTestMode())) {
      return NextResponse.json(
        { error: 'Testing mode is not enabled in this browser' },
        { status: 400 }
      )
    }

    if (action === 'reset_clock') {
      const { error } = await sandboxSupabase.from('clock').update({ simulated_now: null }).eq('id', true)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, simulated_now: null })
    }

    if (action === 'set_clock') {
      const parsed = body?.iso ? new Date(body.iso) : null
      if (!parsed || isNaN(parsed.getTime())) {
        return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
      }
      const { error } = await sandboxSupabase.from('clock').update({ simulated_now: parsed.toISOString() }).eq('id', true)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, simulated_now: parsed.toISOString() })
    }

    if (action === 'advance_clock') {
      const hours = Number(body?.hours)
      if (!Number.isFinite(hours)) return NextResponse.json({ error: 'Missing hours' }, { status: 400 })
      const { data: clockRow } = await sandboxSupabase.from('clock').select('simulated_now').eq('id', true).single()
      const base = clockRow?.simulated_now ? new Date(clockRow.simulated_now) : new Date()
      const next = new Date(base.getTime() + hours * 60 * 60 * 1000)
      const { error } = await sandboxSupabase.from('clock').update({ simulated_now: next.toISOString() }).eq('id', true)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, simulated_now: next.toISOString() })
    }

    if (action === 'jump_to_next_kickoff') {
      const { data: activeSlate } = await sandboxSupabase.from('slates').select('id').eq('is_active', true).single()
      if (!activeSlate) return NextResponse.json({ error: 'No active sandbox slate' }, { status: 400 })
      const { data: clockRow } = await sandboxSupabase.from('clock').select('simulated_now').eq('id', true).single()
      const currentNow = clockRow?.simulated_now ? new Date(clockRow.simulated_now) : new Date()
      const { data: games } = await sandboxSupabase.from('games').select('tip_time').eq('slate_id', activeSlate.id)
      const upcoming = (games || [])
        .map((g: { tip_time: string }) => new Date(g.tip_time))
        .filter((d: Date) => d > currentNow)
        .sort((a: Date, b: Date) => a.getTime() - b.getTime())
      if (upcoming.length === 0) {
        return NextResponse.json({ error: 'No upcoming kickoffs to jump to' }, { status: 400 })
      }
      const next = upcoming[0]
      const { error } = await sandboxSupabase.from('clock').update({ simulated_now: next.toISOString() }).eq('id', true)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, simulated_now: next.toISOString() })
    }

    if (action === 'set_score') {
      const gameId = body?.game_id
      const homeScore = Number(body?.home_score)
      const awayScore = Number(body?.away_score)
      if (!gameId || !Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore < 0 || awayScore < 0) {
        return NextResponse.json({ error: 'Invalid score' }, { status: 400 })
      }
      const { error } = await sandboxSupabase
        .from('games')
        .update({ home_score: Math.trunc(homeScore), away_score: Math.trunc(awayScore) })
        .eq('id', gameId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'finalize_game') {
      const gameId = body?.game_id
      if (!gameId) return NextResponse.json({ error: 'Missing game_id' }, { status: 400 })

      const { data: game } = await sandboxSupabase.from('games').select('*').eq('id', gameId).single()
      if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
      if (game.home_score == null || game.away_score == null) {
        return NextResponse.json({ error: 'Set both scores before finalizing' }, { status: 400 })
      }

      const result: Game['result'] =
        game.home_score > game.away_score ? 'home_win' : game.away_score > game.home_score ? 'away_win' : 'tie'
      const { error: updateErr } = await sandboxSupabase.from('games').update({ result }).eq('id', gameId)
      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

      // Re-grade the whole slate (idempotent) so elimination/standings pick up
      // this and any previously-finalized sandbox games together.
      const { data: slate } = await sandboxSupabase.from('slates').select('slate_number').eq('id', game.slate_id).single()
      const { data: weekGames } = await sandboxSupabase.from('games').select('*').eq('slate_id', game.slate_id)
      const completedGames = ((weekGames || []) as Game[]).filter((g) => g.result !== 'pending')
      const grading = slate
        ? await gradeSlatePicks(sandboxSupabase, game.slate_id, slate.slate_number, completedGames)
        : null

      return NextResponse.json({ ok: true, result, grading })
    }

    if (action === 'reset') {
      // Order matters only for clarity — FKs cascade from slates/players.
      const tables = ['picks', 'games', 'slates', 'players'] as const
      for (const table of tables) {
        const { error } = await sandboxSupabase.from(table).delete().not('id', 'is', null)
        if (error) return NextResponse.json({ error: `Failed to clear ${table}: ${error.message}` }, { status: 500 })
      }
      // Back to real time for the next test run.
      await sandboxSupabase.from('clock').update({ simulated_now: null }).eq('id', true)
      return NextResponse.json({ ok: true })
    }

    if (action === 'seed') {
      const requested = Number(body?.users)
      const userCount = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 0), 30) : 8

      // --- Test users ---
      const { data: existingPlayers, error: playersErr } = await sandboxSupabase
        .from('players')
        .select('email')
      if (playersErr) {
        return NextResponse.json(
          { error: `Sandbox unreachable: ${playersErr.message}. Run supabase/migrations/004_testing_sandbox.sql and 007_sandbox_expose.sql in the Supabase SQL editor.` },
          { status: 500 }
        )
      }
      const existingEmails = new Set((existingPlayers || []).map((p: { email: string }) => p.email))

      // One bcrypt hash shared by all seeded users — they're throwaway
      // sandbox accounts and hashing 30 PINs at cost 12 is needlessly slow.
      const pinHash = await hashPin(TEST_USER_PIN)
      const newUsers = []
      for (let i = 1; i <= userCount; i++) {
        const email = `test.player${i}@nflsurvivor.internal`
        if (existingEmails.has(email)) continue
        newUsers.push({
          full_name: `Test Player ${i}`,
          email,
          pin_hash: pinHash,
          paid: true,
          status: 'alive',
        })
      }
      if (newUsers.length > 0) {
        const { error } = await sandboxSupabase.from('players').insert(newUsers)
        if (error) return NextResponse.json({ error: `Failed to create test users: ${error.message}` }, { status: 500 })
      }

      // --- Test slate + schedule ---
      const { data: slates } = await sandboxSupabase
        .from('slates')
        .select('slate_number, season_year')
        .order('slate_number', { ascending: false })
        .limit(1)
      const latest = slates?.[0]
      const seasonYear = latest?.season_year ?? new Date().getFullYear()
      const slateNumber = (latest?.slate_number ?? 0) + 1

      // Anchor the slate on tomorrow (CT) so its lock is genuinely upcoming
      // and the sandbox clock can be walked across it.
      const nowCt = toZonedTime(new Date(), CHICAGO_TZ)
      const dayCt = new Date(nowCt)
      dayCt.setDate(nowCt.getDate() + 1)
      const slateDate = `${dayCt.getFullYear()}-${String(dayCt.getMonth() + 1).padStart(2, '0')}-${String(dayCt.getDate()).padStart(2, '0')}`

      await sandboxSupabase.from('slates').update({ is_active: false }).eq('is_active', true)
      const { data: newWeek, error: weekErr } = await sandboxSupabase
        .from('slates')
        .insert({
          slate_number: slateNumber,
          slate_date: slateDate,
          season_year: seasonYear,
          is_active: true,
        })
        .select('id')
        .single()
      if (weekErr || !newWeek) {
        return NextResponse.json({ error: `Failed to create test slate: ${weekErr?.message}` }, { status: 500 })
      }

      const games = TEST_SLATE.map((g) => {
        const tipCt = new Date(dayCt)
        tipCt.setHours(g.hour, g.minute, 0, 0)
        return {
          slate_id: newWeek.id,
          // Sandbox games never come from ESPN, but the column is NOT NULL
          // and unique, so they get a synthetic id in their own namespace.
          espn_event_id: `sandbox:${slateDate}:${g.away}@${g.home}`,
          home_team: g.home,
          away_team: g.away,
          tip_time: fromZonedTime(tipCt, CHICAGO_TZ).toISOString(),
          status_state: 'pre',
          result: 'pending',
        }
      })
      const { error: gamesErr } = await sandboxSupabase.from('games').insert(games)
      if (gamesErr) {
        return NextResponse.json({ error: `Failed to create test games: ${gamesErr.message}` }, { status: 500 })
      }

      // The slate locks at its first tip, and the pick page reads that off
      // the cached column rather than re-deriving it.
      const firstTip = games
        .map((g) => g.tip_time)
        .sort()[0]
      await sandboxSupabase.from('slates').update({ locks_at: firstTip }).eq('id', newWeek.id)

      return NextResponse.json({
        ok: true,
        created_users: newUsers.length,
        slate_number: slateNumber,
        games: games.length,
        pin: TEST_USER_PIN,
      })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('test-mode error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
