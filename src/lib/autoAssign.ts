import { revalidateContest } from './revalidateContest'
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Game, Slate } from '@/types'
import { randomUUID } from 'node:crypto'
import { slateDeadline, highestSeedChoice, autoAssignTeam, seedForTeam } from './deadline'
import { getPoolConfig } from './pool'
import { buildPickPeriods, isFinalDayOfRound, sharedRoundPickQuota } from './competition'
import { fetchApRankings } from './espn'
import { withOperation } from './operations'
import { logAudit } from './audit'
import { reportFailure } from './alerts'
import { selectAllIn } from './db'
import { loadAll, loadGamesForSlates, loadPicksForSlates } from './seasonData'

// Filling in picks for players who missed the lock.
//
// The choice comes from the frozen lock-time schedule (and, for the
// tournament, frozen rankings), so a run after tip or final picks the same
// team a run at first tip would have. Page views and public API reads never
// start it: it runs only from scheduled or organizer-initiated work, all
// funnelling into runAutoAssign():
//
//   * the background worker (/api/cron/worker, every minute when
//     AUTOMATION_V2_ENABLED) and its 'assignment' workload;
//   * the daily Vercel cron (/api/cron/auto-assign) and the day turnover
//     (advanceSlate), which refuses to advance until assignment is done;
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
const ASSIGNMENT_BATCH_SIZE = 50

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
    const { error } = await db.from('slates')
      .update({ auto_assign_completed_at: new Date().toISOString(), auto_assign_claimed_at: null })
      .eq('id', slateId)
    if (error) throw error
  } else if (!outcome.results) {
    const { error } = await db.from('slates').update({ auto_assign_claimed_at: null }).eq('id', slateId)
    if (error) throw error
  }
}

// Entry point for the cron and the admin button: always runs (it is
// idempotent), but still takes the claim so it can't overlap a lazy run.
// Before migration 021 there is nothing to claim, so it runs unguarded —
// the pre-migration behaviour.
export async function runAutoAssignNow(db: SupabaseClient, now: Date): Promise<AutoAssignOutcome> {
  const { data: slate, error } = await db.from('slates').select('id').eq('is_active', true).maybeSingle()
  if (error) throw error
  if (!slate) return { ok: true, message: 'No active slate', done: false }

  const durable = process.env.AUTOMATION_V2_ENABLED === 'true'
  if (durable) {
    const result = await withOperation(db, `assignment:${slate.id}`, async () => {
      const { data: token, error } = await db.rpc('begin_assignment', { p_slate_id: slate.id })
      if (error) throw error
      if (!token) {
        const { data: state, error: stateError } = await db.from('slates').select('auto_assign_completed_at').eq('id', slate.id).single()
        if (stateError) throw stateError
        if (!state.auto_assign_completed_at) throw new Error('Assignment claim is still held')
        return { done: true, value: { ok: true, done: true } as AutoAssignOutcome }
      }
      const outcome = await runAutoAssign(db, now, token)
      const { data: finished, error: finishError } = await db.rpc('finish_assignment', { p_slate_id: slate.id, p_token: token, p_done: outcome.ok && outcome.done })
      if (finishError || !finished) throw finishError ?? new Error('Assignment lease expired')
      if (!outcome.ok) throw new Error('Assignment batch failed')
      return { done: outcome.done, value: outcome }
    })
    if (result.claimed) return result.value
    const { data: state, error: stateError } = await db.from('slates').select('auto_assign_completed_at').eq('id', slate.id).single()
    if (stateError) throw stateError
    return { ok: true, done: Boolean(state.auto_assign_completed_at), message: 'Assignment complete, backing off, or claimed by another worker' }
  }
  const claim = await claimSlate(db, slate.id)
  if (claim === 'held') {
    return { ok: true, message: 'Auto-assign is already running for this slate', done: false }
  }
  if (claim === 'unsupported') throw new Error('Atomic assignment claim is unavailable')

  const outcome = await runAutoAssign(db, now)
  await finishClaim(db, slate.id, outcome)
  return outcome
}

// The work itself. Guards itself on the slate's own lock time: before first
// tip it is a no-op, and re-running afterwards is harmless because everyone
// then has their picks.
//
// The active pool configuration decides what a missed lock does: latest-game
// assignment, tournament seed priority, immediate elimination, or no action.
async function runAutoAssign(supabase: SupabaseClient, now: Date, token?: string): Promise<AutoAssignOutcome> {
  const { data: slate, error: slateError } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .maybeSingle<Slate>()

  if (slateError) throw slateError
  if (!slate) return { ok: true, message: 'No active slate', done: false }
  const pool = await getPoolConfig(supabase, true)
  const { data: seasonSlatesData, error: slatesError } = await supabase
    .from('slates')
    .select('id, slate_number, slate_date, locks_at')
    .eq('season_year', slate.season_year)
  if (slatesError) throw slatesError
  const seasonSlates = (seasonSlatesData ?? []).filter(slate => !pool.starts_on || slate.slate_date >= pool.starts_on)
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
  const alivePlayers = (await loadAll<{id: string; full_name: string; email: string; status: string}>(supabase, 'players', 'id, full_name, email, status')).filter(row => row.status === 'alive')

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

  if (pool.auto_pick_behavior === 'none' || playersWithoutPick.length === 0) return { ok: true, done: true }

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
  // Durable workers require the pre-lock snapshot. The existing scheduler
  // retains its legacy behavior until the operations migration is activated.
  const snapshot = (slate as Slate & { assignment_schedule?: Game[] }).assignment_schedule
  if (token && !snapshot?.length) throw new Error('Frozen assignment schedule is unavailable; apply migration 022')
  const assignmentGames = snapshot?.length ? snapshot : gamesData
  // Tournament ties on a seed line are broken by the AP snapshot saved with
  // the slate. Without one, assignments that need it wait (see below).
  const apRanks = useSeedPriority
    ? await savedRankings(supabase, slate as Slate & { assignment_rankings?: Record<string, number> | null }, Boolean(token))
    : {}
  const deferred: string[] = []
  const nameOrdered: string[] = []


  const results: { player: string; action: string }[] = []

  // A durable run writes at most one batch. Entries left waiting for rankings
  // do not use up the batch, so they cannot starve the entries behind them.
  let writes = 0
  let reachedEnd = true
  for (const player of playersWithoutPick) {
    if (token && writes >= ASSIGNMENT_BATCH_SIZE) { reachedEnd = false; break }
    const missing = requiredPicks - (periodPickCount.get(player.id) ?? 0)
    if (pool.auto_pick_behavior === 'eliminate') {
      writes++
      const reason = sharedQuota
        ? `Missed the round quota — needed ${missing} more pick${missing === 1 ? '' : 's'}`
        : 'Missed the lock — pool rule eliminates entries without a pick'
      const { error: eliminateError } = token
        ? await supabase.rpc('apply_assignment', { p_slate_id: slate.id, p_token: token, p_player_id: player.id, p_period_ids: [...eligibleSlateIds], p_expected_count: periodPickCount.get(player.id) ?? 0, p_teams: [], p_reason: reason })
        : await supabase
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


      results.push({ player: player.full_name, action: 'eliminated (configured rule)' })
      continue
    }

    const playerPicks = history.filter((pick) => pick.player_id === player.id)
    const usedTeams = new Set(playerPicks.map((pick) => pick.team))
    const usedSeeds = new Set<number>(
      playerPicks.map((pick) => pick.seed).filter((seed): seed is number => seed !== null)
    )
    const autoTeams: string[] = []
    let needsRankings = false
    for (let index = 0; index < missing; index++) {
      const choice = useSeedPriority
        ? highestSeedChoice(assignmentGames, [...usedTeams], [...usedSeeds], apRanks)
        : { team: autoAssignTeam(assignmentGames, [...usedTeams]), needsRankings: false }
      if (choice.needsRankings) { needsRankings = true; break }
      if (choice.nameOrderTie) nameOrdered.push(player.full_name)
      const autoTeam = choice.team
      if (!autoTeam) break
      autoTeams.push(autoTeam)
      usedTeams.add(autoTeam)
      const seed = seedForTeam(autoTeam, assignmentGames)
      if (seed !== null) usedSeeds.add(seed)
    }

    if (needsRankings) {
      // Never guess between same-seed teams: leave the entry alone and retry
      // once a ranking snapshot exists. Other entries are still assigned.
      deferred.push(player.id)
      results.push({ player: player.full_name, action: 'waiting: AP ranking snapshot unavailable' })
      continue
    }
    writes++

    if (autoTeams.length === missing) {
      const { error: insertError } = token
        ? await supabase.rpc('apply_assignment', { p_slate_id: slate.id, p_token: token, p_player_id: player.id, p_period_ids: [...eligibleSlateIds], p_expected_count: periodPickCount.get(player.id) ?? 0, p_teams: autoTeams.map(team => ({ team, seed: seedForTeam(team, assignmentGames) })) })
        : await supabase.from('picks').insert(
        autoTeams.map((autoTeam) => ({
          player_id: player.id,
          slate_id: slate.id,
          team: autoTeam,
          seed: seedForTeam(autoTeam, assignmentGames),
          auto_assigned: true,
          submitted_by_admin: false,
        }))
      )
      if (insertError) {
        // e.g. an admin entered a pick between our read and this write
        results.push({ player: player.full_name, action: `skipped: ${insertError.message}` })
        continue
      }

      // The database's atomic pick audit records each assignment once.

      // Migration 022 records notification events independently of this worker.
      results.push({ player: player.full_name, action: `auto-assigned ${autoTeams.join(', ')}` })
    } else {
      const reason = sharedQuota
        ? `Missed the round quota — needed ${missing} more pick${missing === 1 ? '' : 's'}`
        : 'Missed the lock — every team on the slate was already used'
      const { error: eliminateError } = token
        ? await supabase.rpc('apply_assignment', { p_slate_id: slate.id, p_token: token, p_player_id: player.id, p_period_ids: [...eligibleSlateIds], p_expected_count: periodPickCount.get(player.id) ?? 0, p_teams: [], p_reason: reason })
        : await supabase
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


      results.push({ player: player.full_name, action: 'eliminated (no auto-assign available)' })
    }
  }

  // Keep successful player writes, but fail a partial batch so durable retries
  // back off and eventually request review instead of reporting endless success.
  const skipped = results.filter((result) => result.action.startsWith('skipped:'))
  if (deferred.length) await recordRankingsMissing(supabase, slate, deferred.length)
  if (nameOrdered.length) await recordNameOrderTie(supabase, slate, nameOrdered.length)
  const done = skipped.length === 0 && deferred.length === 0 && reachedEnd
  if (skipped.length > 0) {
    await reportFailure(supabase, {
      kind: 'job-failed',
      source: 'auto-assign',
      message: `Auto-assign skipped ${skipped.length} player${skipped.length === 1 ? '' : 's'} on Slate ${slate.slate_number} (will retry)`,
      details: { skipped },
    })
  }
  if (results.length) revalidateContest()
  return { ok: skipped.length === 0, results, done }
}

// The AP snapshot for a tournament slate. It is saved before lock by the
// schedule sync. If it was never saved, the first successful read is saved
// now — once, never overwriting — so every later run uses the same ranks.
// Returns null while no non-empty snapshot exists; the caller then defers any
// choice that needs it instead of breaking a tie by name.
async function savedRankings(
  db: SupabaseClient,
  slate: Slate & { assignment_rankings?: Record<string, number> | null },
  durable: boolean
): Promise<Record<string, number> | null> {
  const frozen = slate.assignment_rankings
  if (frozen && Object.keys(frozen).length > 0) return frozen
  const fetched = await fetchApRankings()
  if (Object.keys(fetched).length === 0) return null
  const { data, error } = await db.from('slates').update({ assignment_rankings: fetched })
    .eq('id', slate.id).is('assignment_rankings', null).select('assignment_rankings')
  if (error) {
    // Before migration 024 there is no column to save into; durable runs
    // require it, the legacy path uses the read it just made.
    if (durable) throw error
    return fetched
  }
  if (data?.length) return fetched
  // Another run saved first (or an empty snapshot is stored); use the stored copy.
  const { data: stored, error: readError } = await db.from('slates').select('assignment_rankings').eq('id', slate.id).single()
  if (readError) throw readError
  const saved = stored?.assignment_rankings as Record<string, number> | null
  return saved && Object.keys(saved).length > 0 ? saved : null
}

// Organizer-visible: the incident list when the reliability schema is on,
// the failure trail otherwise. Repeats update the same open incident.
async function recordRankingsMissing(db: SupabaseClient, slate: Slate, waiting: number): Promise<void> {
  const message = `Tournament auto-assign is waiting on ${waiting} entr${waiting === 1 ? 'y' : 'ies'} for Slate ${slate.slate_number}: no AP ranking snapshot is available to separate teams on the same seed line. It retries automatically once rankings load; or enter those picks by hand.`
  if (process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true') {
    const { error } = await db.rpc('record_incident', { p_key: `assignment-rankings:${slate.id}`, p_impact: message,
      p_correlation: randomUUID(), p_detail: JSON.stringify({ slate_id: slate.id, slate_number: slate.slate_number, waiting }) })
    if (error) throw error
  } else {
    await reportFailure(db, { kind: 'job-failed', source: 'auto-assign', key: `assignment-rankings:${slate.id}`, message })
  }
}

// Two teams on the chosen seed line that the saved AP snapshot cannot
// separate (both unranked) are still decided by name, as before. That is the
// rule's last resort, not a substitute for missing data, but the organizer is
// told each time it decides an assignment.
async function recordNameOrderTie(db: SupabaseClient, slate: Slate, count: number): Promise<void> {
  const message = `Tournament auto-assign on Slate ${slate.slate_number} chose between same-seed teams the AP snapshot does not rank, by team name, for ${count} entr${count === 1 ? 'y' : 'ies'}. Review if the pool needs a different tiebreak.`
  if (process.env.TOURNAMENT_RELIABILITY_ENABLED === 'true') {
    const { error } = await db.rpc('record_incident', { p_key: `assignment-name-order:${slate.id}`, p_impact: message,
      p_correlation: randomUUID(), p_detail: JSON.stringify({ slate_id: slate.id, slate_number: slate.slate_number, count }) })
    if (error) throw error
  } else {
    await reportFailure(db, { kind: 'job-failed', source: 'auto-assign', key: `assignment-name-order:${slate.id}`, message })
  }
}
