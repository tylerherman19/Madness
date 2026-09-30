import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Slate } from '@/types'
import { slateDeadline, autoAssignHighestSeed, autoAssignTeam, seedForTeam } from './deadline'
import { getPoolConfig } from './pool'
import { buildPickPeriods, isFinalDayOfRound, sharedRoundPickQuota } from './competition'
import { fetchApRankings } from './espn'
import { sendEliminationEmail, sendPickConfirmationEmail } from './email'
import { logAudit } from './audit'
import { selectAllIn } from './db'
import { loadGamesForSlates, loadPicksForSlates } from './seasonData'

// Filling in picks for players who missed the lock.
//
// This runs as soon as the active slate's first game tips, not overnight:
// the "latest game" rule exists to hand a missed player a game that has not
// started yet, which only works while the day is still being played. It is
// started from three places, all funnelling into runAutoAssign():
//
//   * autoAssignIfDue(), called after responses the site serves constantly
//     (the live-scores ticker, the sweat board, the pick page) — this is what
//     makes it fire within a minute or two of first tip;
//   * the daily Vercel cron, as a backstop for a day nobody visits;
//   * the admin "Run Auto-Assign" button.
//
// Every entry point first claims the slate (slates.auto_assign_claimed_at),
// so two triggers can never both insert picks for the same players.

export interface AutoAssignOutcome {
  ok: boolean
  message?: string
  results?: { player: string; action: string }[]
  // True once the slate has locked and nothing more is left to assign.
  // Only then do later triggers stop retrying.
  done: boolean
}

// A claim older than this is treated as abandoned (the function that held it
// died mid-run) and can be taken over.
const CLAIM_LEASE_SECONDS = 10 * 60

type Claim = 'claimed' | 'held' | 'unsupported'

async function claimSlate(db: SupabaseClient, slateId: string): Promise<Claim> {
  // Atomic in Postgres (migration 021): exactly one concurrent caller wins.
  const { data, error } = await db.rpc('claim_slate_auto_assign', {
    p_slate_id: slateId,
    p_lease_seconds: CLAIM_LEASE_SECONDS,
  })
  if (error) {
    // Migration 021 not applied yet — there is nothing to claim with.
    console.warn('auto-assign claim unavailable:', error.message)
    return 'unsupported'
  }
  return data === true ? 'claimed' : 'held'
}

// Settle a claim after a run:
//   * done — mark the slate complete so lazy triggers stop checking it;
//   * attempted but not done (a write failed for someone) — keep the lease,
//     so the retry waits out CLAIM_LEASE_SECONDS instead of re-running on
//     every ticker request;
//   * nothing attempted (slate not locked yet, no games) — release it.
// A thrown run also keeps its lease, for the same reason.
async function finishClaim(db: SupabaseClient, slateId: string, outcome: AutoAssignOutcome): Promise<void> {
  if (outcome.ok && outcome.done) {
    await db
      .from('slates')
      .update({ auto_assign_completed_at: new Date().toISOString(), auto_assign_claimed_at: null })
      .eq('id', slateId)
  } else if (!outcome.results) {
    await db.from('slates').update({ auto_assign_claimed_at: null }).eq('id', slateId)
  }
}

// Entry point for the cron and the admin button: always runs (it is
// idempotent), but still takes the claim so it can't overlap a lazy run.
// Before migration 021 there is nothing to claim, so it runs unguarded —
// the pre-migration behaviour.
export async function runAutoAssignNow(db: SupabaseClient, now: Date): Promise<AutoAssignOutcome> {
  const { data: slate } = await db.from('slates').select('id').eq('is_active', true).maybeSingle()
  if (!slate) return { ok: true, message: 'No active slate', done: false }

  const claim = await claimSlate(db, slate.id)
  if (claim === 'held') {
    return { ok: true, message: 'Auto-assign is already running for this slate', done: false }
  }
  if (claim === 'unsupported') return runAutoAssign(db, now)

  const outcome = await runAutoAssign(db, now)
  await finishClaim(db, slate.id, outcome)
  return outcome
}

// Lazy trigger: cheap to call on every request. Does nothing until the active
// slate has locked, and nothing again once a run has completed for it.
export async function autoAssignIfDue(db: SupabaseClient, now: Date): Promise<void> {
  try {
    const { data: slate, error } = await db
      .from('slates')
      .select('id, locks_at, auto_assign_completed_at')
      .eq('is_active', true)
      .maybeSingle()
    if (error || !slate || slate.auto_assign_completed_at || !slate.locks_at) return
    if (now < new Date(slate.locks_at)) return

    if ((await claimSlate(db, slate.id)) !== 'claimed') return
    await finishClaim(db, slate.id, await runAutoAssign(db, now))
  } catch (err) {
    console.error('lazy auto-assign failed', err)
  }
}

// The work itself. Guards itself on the slate's own lock time: before first
// tip it is a no-op, and re-running afterwards is harmless because everyone
// then has their picks.
//
// The active pool configuration decides what a missed lock does: latest-game
// assignment, tournament seed priority, immediate elimination, or no action.
async function runAutoAssign(supabase: SupabaseClient, now: Date): Promise<AutoAssignOutcome> {
  const { data: slate } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .maybeSingle<Slate>()

  if (!slate) return { ok: true, message: 'No active slate', done: false }

  const pool = await getPoolConfig(supabase)
  const { data: seasonSlatesData, error: slatesError } = await supabase
    .from('slates')
    .select('id, slate_number, slate_date, locks_at')
    .eq('season_year', slate.season_year)
  if (slatesError) throw slatesError
  const seasonSlates = seasonSlatesData ?? []
  const seasonSlateIds = seasonSlates.map((row) => row.id)

  // Paged and season-scoped: a truncated read here would make players who
  // did pick look like they missed, and hand them a second, automatic pick.
  const allGames = await loadGamesForSlates(supabase, seasonSlateIds)
  const gamesData: Game[] = allGames.filter((game) => game.slate_id === slate.id)

  if (gamesData.length === 0) {
    return { ok: true, message: 'No games found', done: false }
  }

  // Only act once the slate has locked (in test mode, against the
  // sandbox's simulated clock).
  const deadline = slateDeadline(slate, gamesData)
  if (!deadline || now < deadline) {
    return { ok: true, message: 'Slate has not locked yet', done: false }
  }

  const periods = buildPickPeriods(pool.competition_mode, seasonSlates, allGames)
  const activePeriod = periods.find((period) => period.id === slate.id)
  const sharedQuota = sharedRoundPickQuota(
    pool.competition_mode,
    pool.pick_frequency,
    activePeriod?.round ?? null
  )
  const eligibleSlateIds = sharedQuota
    ? new Set(periods.filter((period) => period.round === activePeriod?.round).map((period) => period.id))
    : new Set([slate.id])

  // A shared round stays open across its playing days. Missing selections
  // are filled only once its final day locks, so nobody is forced into a
  // first-day team while they still had the second day available — including
  // when that second day hasn't been synced yet.
  if (sharedQuota && activePeriod && !isFinalDayOfRound(activePeriod, periods)) {
    return { ok: true, message: 'Round remains open on a later game day', done: true }
  }

  // Find alive players who have not completed this slate or round quota.
  const { data: alivePlayers, error: playersError } = await supabase
    .from('players')
    .select('id, full_name, email')
    .eq('status', 'alive')
  if (playersError) throw playersError

  if (!alivePlayers || alivePlayers.length === 0) {
    return { ok: true, message: 'No alive players', done: true }
  }

  const seasonPicks = await loadPicksForSlates<{ player_id: string; slate_id: string }>(
    supabase, seasonSlateIds, 'player_id, slate_id'
  )

  const requiredPicks = sharedQuota ?? 1
  const periodPickCount = new Map<string, number>()
  for (const pick of seasonPicks) {
    if (!eligibleSlateIds.has(pick.slate_id)) continue
    periodPickCount.set(pick.player_id, (periodPickCount.get(pick.player_id) ?? 0) + 1)
  }

  const playersWithoutPick = alivePlayers.filter(
    (player: { id: string }) => (periodPickCount.get(player.id) ?? 0) < requiredPicks
  )

  // Every team each of these players has ever used. The no-repeat index
  // (player_id, team) spans all history, not just this season, so the
  // assignment must avoid the same set or its insert would be rejected.
  const history = await selectAllIn<{ player_id: string; team: string; seed: number | null }>(
    playersWithoutPick.map((player) => player.id),
    (batch, from, to) =>
      supabase.from('picks').select('player_id, team, seed').in('player_id', batch).order('id').range(from, to)
  )

  const useSeedPriority =
    pool.auto_pick_behavior === 'highest-seed' && pool.competition_mode === 'march-madness'
  const apRanks = useSeedPriority ? await fetchApRankings() : {}

  const results: { player: string; action: string }[] = []

  for (const player of playersWithoutPick) {
    if (pool.auto_pick_behavior === 'none') {
      results.push({ player: player.full_name, action: 'left blank (auto-pick disabled)' })
      continue
    }

    const missing = requiredPicks - (periodPickCount.get(player.id) ?? 0)
    if (pool.auto_pick_behavior === 'eliminate') {
      const reason = sharedQuota
        ? `Missed the round quota — needed ${missing} more pick${missing === 1 ? '' : 's'}`
        : 'Missed the lock — pool rule eliminates entries without a pick'
      const { error: eliminateError } = await supabase
        .from('players')
        .update({
          status: 'eliminated',
          elimination_slate: slate.slate_number,
          elimination_reason: reason,
        })
        .eq('id', player.id)

      if (eliminateError) {
        results.push({ player: player.full_name, action: `skipped: ${eliminateError.message}` })
        continue
      }

      await logAudit(supabase, {
        event_type: 'player-eliminated',
        actor: 'system',
        player_id: player.id,
        player_name: player.full_name,
        message: `${player.full_name} eliminated — ${reason}`,
        details: { slate_number: slate.slate_number, cause: 'missed-deadline', auto_pick_behavior: 'eliminate' },
      })

      if (player.email) {
        await sendEliminationEmail(player.email, player.full_name, null, slate.slate_number)
      }

      results.push({ player: player.full_name, action: 'eliminated (configured rule)' })
      continue
    }

    const playerPicks = history.filter((pick) => pick.player_id === player.id)
    const usedTeams = new Set(playerPicks.map((pick) => pick.team))
    const usedSeeds = new Set<number>(
      playerPicks.map((pick) => pick.seed).filter((seed): seed is number => seed !== null)
    )
    const autoTeams: string[] = []
    for (let index = 0; index < missing; index++) {
      const autoTeam = useSeedPriority
        ? autoAssignHighestSeed(gamesData, [...usedTeams], [...usedSeeds], apRanks)
        : autoAssignTeam(gamesData, [...usedTeams])
      if (!autoTeam) break
      autoTeams.push(autoTeam)
      usedTeams.add(autoTeam)
      const seed = seedForTeam(autoTeam, gamesData)
      if (seed !== null) usedSeeds.add(seed)
    }

    if (autoTeams.length === missing) {
      const { error: insertError } = await supabase.from('picks').insert(
        autoTeams.map((autoTeam) => ({
          player_id: player.id,
          slate_id: slate.id,
          team: autoTeam,
          seed: seedForTeam(autoTeam, gamesData),
          auto_assigned: true,
          submitted_by_admin: false,
        }))
      )
      if (insertError) {
        // e.g. an admin entered a pick between our read and this write
        results.push({ player: player.full_name, action: `skipped: ${insertError.message}` })
        continue
      }

      await logAudit(supabase, {
        event_type: 'pick-auto-assigned',
        actor: 'system',
        player_id: player.id,
        player_name: player.full_name,
        message: `${player.full_name} missed the Slate ${slate.slate_number} deadline — auto-assigned ${autoTeams.join(', ')}`,
        details: {
          slate_number: slate.slate_number,
          teams: autoTeams,
          required_picks: requiredPicks,
          auto_pick_behavior: pool.auto_pick_behavior,
        },
      })

      // Awaited: fire-and-forget sends can be dropped when the serverless
      // function is frozen after responding. Failures are logged inside the
      // sender; the assignment itself already succeeded.
      if (player.email) {
        for (const autoTeam of autoTeams) {
          await sendPickConfirmationEmail(player.email, player.full_name, autoTeam, slate.slate_number)
        }
      }

      results.push({ player: player.full_name, action: `auto-assigned ${autoTeams.join(', ')}` })
    } else {
      const reason = sharedQuota
        ? `Missed the round quota — needed ${missing} more pick${missing === 1 ? '' : 's'}`
        : 'Missed the lock — every team on the slate was already used'
      const { error: eliminateError } = await supabase
        .from('players')
        .update({
          status: 'eliminated',
          elimination_slate: slate.slate_number,
          elimination_reason: reason,
        })
        .eq('id', player.id)

      if (eliminateError) {
        // Leave player alive — the next run (this deadline check still
        // passes) retries instead of falsely reporting them eliminated.
        results.push({ player: player.full_name, action: `skipped: ${eliminateError.message}` })
        continue
      }

      await logAudit(supabase, {
        event_type: 'player-eliminated',
        actor: 'system',
        player_id: player.id,
        player_name: player.full_name,
        message: `${player.full_name} eliminated — ${reason}`,
        details: { slate_number: slate.slate_number, cause: 'missed-deadline' },
      })

      if (player.email) {
        await sendEliminationEmail(player.email, player.full_name, null, slate.slate_number)
      }

      results.push({ player: player.full_name, action: 'eliminated (no auto-assign available)' })
    }
  }

  // Anything skipped over a write error is retried by the next trigger.
  const done = !results.some((result) => result.action.startsWith('skipped:'))
  return { ok: true, results, done }
}
