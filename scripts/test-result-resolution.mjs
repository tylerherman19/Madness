// Result resolution (migration 033): manual results, void, regrade, contest_state. Runs in public and sandbox.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
for (const file of (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
}
// Re-applying the migration is a no-op.
await db.exec(await readFile('supabase/migrations/033_result_resolution.sql', 'utf8'))
const sql = (text) => db.exec(text)
const q = async (text, params = []) => (await db.query(text, params)).rows
const scalar = async (text, params = []) => Object.values((await q(text, params))[0] ?? {})[0]
const fails = (text, match) => assert.rejects(sql(text), match)

const D = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SL = (n) => D(1000 + n)
const P = (n) => D(2000 + n)
const G = (n) => D(3000 + n)

async function reset(schema, { mode = 'regular-season', startsOn = null } = {}) {
  await sql(`set search_path to ${schema},pg_catalog;
    truncate players,picks,games,slates,notification_outbox,pick_revisions,pick_requests,incidents,audit_log cascade;
    ${schema === 'sandbox' ? 'update clock set simulated_now=null;' : ''}
    update pools set season_year=2027,competition_mode='${mode}',pick_frequency='${mode === 'march-madness' ? 'tournament-round' : 'every-game-day'}',
      starts_on=${startsOn ? `'${startsOn}'` : 'null'},status='open',is_active=true;`)
}
const player = (n) => sql(`insert into players(id,full_name,email,pin_hash) values('${P(n)}','Entry ${n}','e${n}@example.test','x')`)
const slate = (n, { date, active = false, locks = "now()-interval '1 day'" } = {}) =>
  sql(`insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at,auto_assign_completed_at)
    values('${SL(n)}',${n},${date ?? `current_date+${n}`},2027,${active},${locks},now())`)
const game = (n, slateN, home, away, { tip = "now()-interval '10 hours'", round = null } = {}) =>
  sql(`insert into games(id,slate_id,espn_event_id,home_team,away_team,tip_time,round_label)
    values('${G(n)}','${SL(slateN)}','ev${n}','${home}','${away}',${tip},${round ? `'${round}'` : 'null'})`)
const pick = (p, s, team) => sql(`insert into picks(player_id,slate_id,team,auto_assigned) values('${P(p)}','${SL(s)}','${team}',true)`)
const status = async (p) => (await q(`select status,elimination_slate from players where id='${P(p)}'`))[0]
const regrade = (s) => scalar(`select regrade_slate('${SL(s)}')`)
const setResult = (g, r, reason = 'Official box score') => scalar(`select admin_set_result('${G(g)}','${r}','${reason}')`)
const auditCount = (type) => scalar(`select count(*)::int from audit_log where event_type='${type}'`)
const espnUpsert = (g, slateN, home, away, result, score) =>
  sql(`insert into games(slate_id,espn_event_id,home_team,away_team,tip_time,result,home_score,away_score,status_state)
    values('${SL(slateN)}','ev${g}','${home}','${away}',now(),'${result}',${score},0,'post')
    on conflict(espn_event_id) do update set result=excluded.result,home_score=excluded.home_score,away_score=excluded.away_score,status_state=excluded.status_state`)

for (const schema of ['public', 'sandbox']) {
  // ---- 1. A manual result survives ESPN; releasing it hands control back -------------------------------
  await reset(schema)
  for (const n of [1, 2]) await player(n)
  await slate(1, { active: true })
  await game(1, 1, 'A', 'B')
  await pick(1, 1, 'A'); await pick(2, 1, 'B')
  await fails(`select admin_set_result('${G(1)}','home_win','')`, /reason is required/)
  await fails(`select admin_set_result('${G(1)}','nonsense','Because')`, /Invalid result/)
  assert.equal((await setResult(1, 'home_win', 'Scorer confirmed')).changed, true)
  assert.equal((await setResult(1, 'home_win', 'Scorer confirmed')).changed, false, 'a repeat is a no-op')
  for (let i = 0; i < 50; i++) await espnUpsert(1, 1, 'A', 'B', i % 2 ? 'away_win' : 'pending', i)
  let row = (await q(`select result,result_source,result_note,home_score from games`))[0]
  assert.equal(row.result, 'home_win'); assert.equal(row.result_source, 'admin'); assert.equal(row.result_note, 'Scorer confirmed')
  assert.equal(row.home_score, 49, 'scores and status still refresh from ESPN')
  assert.equal(await auditCount('result-corrected'), 0, 'ESPN disagreement is not a correction')
  await regrade(1)
  assert.equal((await status(1)).status, 'alive'); assert.equal((await status(2)).status, 'eliminated')
  await fails(`select release_result('${G(1)}','')`, /reason is required/)
  assert.equal((await scalar(`select release_result('${G(1)}','Feed is right now')`)).changed, true)
  assert.equal((await scalar(`select release_result('${G(1)}','Feed is right now')`)).changed, false)
  await espnUpsert(1, 1, 'A', 'B', 'away_win', 7)
  row = (await q(`select result,result_source from games`))[0]
  assert.deepEqual([row.result, row.result_source], ['away_win', 'espn'], 'after release ESPN wins')
  // The flipped result: entry 2 is put back, entry 1 is out.
  const flipped = await regrade(1)
  assert.deepEqual(flipped.restored, ['Entry 2']); assert.deepEqual(flipped.eliminated, ['Entry 1'])
  assert.equal((await status(2)).status, 'alive'); assert.equal((await status(1)).status, 'eliminated')
  console.log(`PASS ${schema}: manual result survives 50 disagreeing ESPN syncs, is audited-ready and idempotent; release lets ESPN win`)

  // ---- 2. Void -----------------------------------------------------------------------------------------
  await reset(schema)
  for (const n of [1, 2, 3, 4]) await player(n)
  await slate(1, { active: true }); await slate(2, { locks: "now()+interval '1 day'" })
  await game(1, 1, 'A', 'B'); await game(2, 1, 'C', 'D'); await game(3, 2, 'E', 'F', { tip: "now()+interval '1 day'" })
  await pick(1, 1, 'A'); await pick(2, 1, 'B'); await pick(3, 1, 'C'); await pick(4, 1, 'D')
  await setResult(2, 'home_win')
  await regrade(1)
  assert.equal((await status(4)).status, 'eliminated')
  await fails(`select activate_ready_slate('${SL(1)}','${SL(2)}','{}',false)`, /Results incomplete/)
  await fails(`select void_game('${G(1)}','')`, /reason is required/)
  const voided = await scalar(`select void_game('${G(1)}','Postponed by the league')`)
  assert.equal(voided.changed, true); assert.equal(voided.excused, 2)
  assert.equal((await scalar(`select void_game('${G(1)}','Postponed by the league')`)).changed, false, 'double void is a no-op')
  await espnUpsert(1, 1, 'A', 'B', 'home_win', 3)
  assert.equal(await scalar(`select result from games where id='${G(1)}'`), 'void', 'ESPN cannot un-void or grade a voided game')
  // Undo before advance restores the pending state and the original pick flags.
  assert.equal((await scalar(`select unvoid_game('${G(1)}','Rescheduled for tonight')`)).changed, true)
  assert.equal(await scalar(`select count(*)::int from picks where loss_excused`), 0)
  assert.equal(await scalar(`select result from games where id='${G(1)}'`), 'pending')
  await fails(`select activate_ready_slate('${SL(1)}','${SL(2)}','{}',false)`, /Results incomplete/)
  await scalar(`select void_game('${G(1)}','Postponed by the league')`)
  const graded = await regrade(1)
  assert.deepEqual(graded.eliminated, [])
  await sql(`select activate_ready_slate('${SL(1)}','${SL(2)}','{}',false)`)
  assert.equal(await scalar(`select id from slates where is_active`), SL(2), 'the slate advances past a voided game')
  assert.equal((await status(1)).status, 'alive'); assert.equal((await status(2)).status, 'alive')
  assert.equal(await scalar(`select count(*)::int from picks where loss_excused`), 2)
  await fails(`select unvoid_game('${G(1)}','Too late')`, /already advanced/)
  await fails(`insert into picks(player_id,slate_id,team,auto_assigned) values('${P(1)}','${SL(2)}','A',true)`, /./)
  assert.equal(await scalar(`select count(*)::int from picks where player_id='${P(1)}'`), 1, 'the voided team stays used and no extra pick appears')
  console.log(`PASS ${schema}: void unblocks advancement, picks survive, ESPN cannot un-void, undo works before advance and not after`)

  // ---- 3. A -> B -> A ----------------------------------------------------------------------------------
  await reset(schema)
  for (const n of [1, 2, 3, 4]) await player(n)
  await slate(1, { active: true }); await game(1, 1, 'A', 'B')
  await pick(1, 1, 'A'); await pick(2, 1, 'A'); await pick(3, 1, 'B'); await pick(4, 1, 'B')
  const state = async () => (await q(`select full_name,status from players order by full_name`)).map((r) => `${r.full_name}:${r.status}`).join(',')
  await setResult(1, 'home_win', 'First'); await regrade(1)
  assert.equal(await state(), 'Entry 1:alive,Entry 2:alive,Entry 3:eliminated,Entry 4:eliminated')
  await setResult(1, 'away_win', 'Correction'); await regrade(1)
  assert.equal(await state(), 'Entry 1:eliminated,Entry 2:eliminated,Entry 3:alive,Entry 4:alive')
  await setResult(1, 'home_win', 'Corrected back'); await regrade(1)
  assert.equal(await state(), 'Entry 1:alive,Entry 2:alive,Entry 3:eliminated,Entry 4:eliminated')
  const events = await auditCount('player-eliminated')
  const updates = await auditCount('player-updated')
  assert.equal(events, 6); assert.equal(updates, 4)
  for (let i = 0; i < 3; i++) assert.deepEqual(await regrade(1), { eliminated: [], restored: [], manual: [] })
  assert.equal(await auditCount('player-eliminated'), events); assert.equal(await auditCount('player-updated'), updates)
  assert.equal(await state(), 'Entry 1:alive,Entry 2:alive,Entry 3:eliminated,Entry 4:eliminated')
  assert.match(await scalar(`select elimination_reason from players where id='${P(3)}'`), /^Slate 1: picked B — lost$/)
  assert.equal(await scalar(`select count(*)::int from games where graded_at is not null`), 1)
  console.log(`PASS ${schema}: A->B->A ends with exactly the statuses of the final result; repeat grading changes nothing and adds no audit rows`)

  // ---- 4. Correction after a later day locked: no auto-restore, listed, one incident -------------------
  await reset(schema)
  for (const n of [1, 2, 3]) await player(n)
  await slate(1, { date: 'current_date-1' }); await slate(2, { active: true, date: 'current_date' })
  await game(1, 1, 'A', 'B'); await game(2, 2, 'C', 'D')
  await pick(1, 1, 'A'); await pick(2, 1, 'B')
  await setResult(1, 'home_win'); await regrade(1)
  assert.equal((await status(2)).status, 'eliminated')
  await setResult(1, 'away_win', 'Wrong team was entered')
  for (let i = 0; i < 3; i++) {
    const again = await regrade(1)
    assert.deepEqual(again.manual, ['Entry 2'], 'listed for a manual restore')
    assert.deepEqual(again.restored, [])
  }
  assert.equal((await status(2)).status, 'eliminated', 'not auto-restored once a later day has locked')
  assert.equal(await scalar(`select count(*)::int from incidents where key like 'wrongly-eliminated:%'`), 1)
  assert.equal(await scalar(`select occurrences from incidents where key like 'wrongly-eliminated:%'`), 1, 'one incident, not one per grading run')
  const attention = await scalar('select results_attention()')
  assert.deepEqual(attention.restore.map((r) => r.name), ['Entry 2'])
  await sql(`select restore_player('${P(2)}','Result corrected','test-admin')`)
  assert.deepEqual((await scalar('select results_attention()')).restore, [])
  assert.equal(await scalar(`select elimination_source from players where id='${P(2)}'`), null)
  // Stalled games: pending more than six hours after tip, with pick counts.
  await game(3, 2, 'G', 'H', { tip: "now()-interval '7 hours'" }); await game(4, 2, 'I', 'J', { tip: "now()-interval '2 hours'" })
  await pick(3, 2, 'G')
  const stalled = (await scalar('select results_attention()')).stalled.filter((s) => s.home_team === 'G' || s.home_team === 'I')
  assert.equal(stalled.length, 1); assert.equal(stalled[0].home_team, 'G'); assert.equal(stalled[0].home_picks, 1); assert.equal(stalled[0].away_picks, 0)
  console.log(`PASS ${schema}: correction after a later day locked is not auto-restored, appears once in the attention list, stalled games listed`)

  // ---- 5. Manual elimination is never reversed ---------------------------------------------------------
  await reset(schema)
  for (const n of [1, 2]) await player(n)
  await slate(1, { active: true }); await game(1, 1, 'A', 'B')
  await pick(1, 1, 'A'); await pick(2, 1, 'B')
  await sql(`update players set status='eliminated',elimination_reason='Removed by organizer',elimination_slate=1 where id='${P(1)}'`)
  await setResult(1, 'home_win'); await regrade(1)
  assert.equal((await status(1)).status, 'eliminated', 'manual elimination with a winning pick stays')
  assert.equal((await status(2)).status, 'eliminated')
  await sql(`select restore_player('${P(2)}','Admin decided','test-admin')`)
  await sql(`update players set status='eliminated',elimination_reason='Removed again',elimination_slate=1 where id='${P(2)}'`)
  await setResult(1, 'away_win', 'Flip'); await regrade(1)
  assert.equal((await status(2)).status, 'eliminated', 'a manual re-elimination is not mistaken for grading')
  // an admin who rewrites the reason of a grading elimination has made a ruling; a later correction must not undo it
  await reset(schema)
  for (const n of [1, 2]) await player(n)
  await slate(1, { active: true }); await game(1, 1, 'A', 'B')
  await pick(1, 1, 'A'); await pick(2, 1, 'B')
  await setResult(1, 'home_win'); await regrade(1)
  assert.equal((await status(2)).status, 'eliminated')
  await sql(`update players set elimination_reason='Organizer ruling' where id='${P(2)}'`)
  await setResult(1, 'away_win', 'Flip'); await regrade(1)
  assert.equal((await status(2)).status, 'eliminated', 'an elimination the admin has edited is not auto-restored')
  console.log(`PASS ${schema}: manual eliminations are never auto-restored`)

  // ---- 6. Two-pick round -------------------------------------------------------------------------------
  await reset(schema, { mode: 'march-madness' })
  for (const n of [1, 2]) await player(n)
  await slate(1, { date: 'current_date-2' }); await slate(2, { date: 'current_date-1', active: true })
  await game(1, 1, 'A', 'B', { round: '1st Round' }); await game(2, 1, 'E', 'F', { round: '1st Round' })
  await game(3, 2, 'C', 'D', { round: '1st Round' })
  await pick(1, 1, 'A'); await pick(1, 2, 'C'); await pick(2, 1, 'B'); await pick(2, 2, 'D')
  await setResult(1, 'home_win'); await setResult(3, 'home_win')
  await regrade(1); await regrade(2)
  assert.equal((await status(1)).status, 'alive'); assert.equal((await status(2)).status, 'eliminated')
  await setResult(3, 'away_win', 'Second pick lost'); await regrade(2)
  assert.deepEqual(await status(1), { status: 'eliminated', elimination_slate: 2 })
  await setResult(1, 'away_win', 'First pick lost too'); await regrade(1)
  await setResult(3, 'home_win', 'Second pick won'); await regrade(2)
  assert.equal((await status(1)).status, 'eliminated', 'every pick in the round must win')
  await setResult(1, 'home_win', 'First pick won'); await regrade(1); await regrade(2)
  assert.equal((await status(1)).status, 'alive', 'restored once every pick wins')
  assert.equal((await status(2)).status, 'eliminated')
  console.log(`PASS ${schema}: two-pick round survives only when every pick wins, restores when corrected`)

  // ---- 7. contest_state --------------------------------------------------------------------------------
  const state7 = () => scalar('select contest_state()')
  await reset(schema)
  await slate(1, { active: true }); await game(1, 1, 'A', 'B')
  let cs = await state7()
  assert.deepEqual(cs, { registered: 0, alive: 0, eliminated: 0, started: true, stopped: false }, 'zero registered never stops anything')
  await player(1)
  await sql(`update games set tip_time=now()+interval '1 day'`)
  cs = await state7()
  assert.deepEqual(cs, { registered: 1, alive: 1, eliminated: 0, started: false, stopped: false }, 'one registered, before the first tip')
  await sql(`update players set status='eliminated'`)
  assert.equal((await state7()).stopped, false, 'nobody alive before the start does not stop the contest')
  await sql(`update players set status='alive'`)
  await sql(`update games set tip_time=now()-interval '1 minute'`)
  assert.equal((await state7()).started, true, 'regular season starts at the first tip')
  await reset(schema, { startsOn: '2027-06-01' })
  await slate(1, { active: true, date: "'2027-05-01'" }); await slate(2, { date: "'2027-06-01'", locks: "now()+interval '30 days'" })
  await game(1, 1, 'A', 'B'); await game(2, 2, 'C', 'D', { tip: "now()+interval '30 days'" }); await player(1)
  assert.equal((await state7()).started, false, 'games before starts_on do not start the contest')
  if (schema === 'sandbox') {
    await sql(`update clock set simulated_now=now()+interval '31 days'`)
    assert.equal((await state7()).started, true, 'the sandbox clock decides')
    await sql(`update clock set simulated_now=null`)
  }

  await reset(schema, { mode: 'march-madness' })
  for (const n of [1, 2]) await player(n)
  await slate(1, { date: 'current_date-1', active: true })
  await game(9, 1, 'Z', 'Y', { round: 'First Four' }); await game(1, 1, 'A', 'B', { round: '1st Round' }); await game(2, 1, 'C', 'D', { round: '1st Round' })
  await pick(1, 1, 'A'); await pick(2, 1, 'C')
  assert.equal((await state7()).started, false)
  await sql(`update games set result='home_win' where id='${G(9)}'`)
  assert.equal((await state7()).started, false, 'First Four does not count')
  await setResult(1, 'home_win'); await setResult(2, 'away_win')
  assert.equal((await state7()).started, false, 'final but not yet graded')
  await regrade(1)
  assert.equal((await state7()).started, true, 'Round 1 final and graded')
  assert.equal((await state7()).alive, 1)
  // one alive: the contest continues, picks are accepted, nothing stops
  assert.equal((await state7()).stopped, false)
  await slate(2, { locks: "now()+interval '1 day'" }); await game(5, 2, 'M', 'N', { tip: "now()+interval '1 day'", round: '2nd Round' })
  await pick(1, 2, 'M')
  await sql(`select activate_ready_slate('${SL(1)}','${SL(2)}','{}',false)`)
  // a voided Round 1 game counts as resolved without grading
  await reset(schema, { mode: 'march-madness' })
  await player(1); await slate(1, { date: 'current_date-1', active: true })
  await game(1, 1, 'A', 'B', { round: '1st Round' }); await game(2, 1, 'C', 'D', { round: 'First Round' })
  await pick(1, 1, 'A'); await setResult(1, 'home_win'); await regrade(1)
  assert.equal((await state7()).started, false, 'one Round 1 game still pending')
  await scalar(`select void_game('${G(2)}','Cancelled')`)
  assert.equal((await state7()).started, true, 'void counts as resolved')

  // zero alive after the start: stopped; picks refused; standings and pool status untouched; restore resumes
  await reset(schema, { mode: 'march-madness' })
  for (const n of [1, 2]) await player(n)
  await slate(1, { date: 'current_date-1', active: true }); await slate(2, { locks: "now()+interval '1 day'" })
  await game(1, 1, 'A', 'B', { round: '1st Round' }); await game(2, 2, 'M', 'N', { tip: "now()+interval '1 day'", round: '2nd Round' })
  await pick(1, 1, 'B'); await pick(2, 1, 'B')
  await setResult(1, 'home_win'); await regrade(1)
  cs = await state7()
  assert.deepEqual(cs, { registered: 2, alive: 0, eliminated: 2, started: true, stopped: true })
  await sql(`insert into players(id,full_name,email,pin_hash) values('${P(99)}','Internal','t@nflsurvivor.internal','x')`)
  assert.equal((await state7()).stopped, true, 'an alive internal test account does not keep the contest open')
  await sql(`delete from players where id='${P(99)}'`)
  const poolBefore = await q('select status,is_active from pools where is_active')
  await fails(`insert into picks(player_id,slate_id,team,auto_assigned) values('${P(1)}','${SL(2)}','M',false)`, /no entries left alive/)
  assert.deepEqual(await q('select status,is_active from pools where is_active'), poolBefore, 'pool status is not changed')
  assert.equal(await scalar(`select count(*)::int from players where status='eliminated'`), 2, 'standings stay as they are')
  await sql(`select restore_player('${P(1)}','Admin restored','test-admin')`)
  cs = await state7()
  assert.equal(cs.stopped, false); assert.equal(cs.alive, 1)
  await sql(`insert into picks(player_id,slate_id,team,auto_assigned) values('${P(1)}','${SL(2)}','M',true)`)
  console.log(`PASS ${schema}: contest_state across registration, first tip, Round 1 grading, one alive, zero alive and restore`)

  // ---- 8. Nothing records a winner ---------------------------------------------------------------------
  const columns = await q(`select table_name,column_name from information_schema.columns where table_schema='${schema}' and (column_name ~* '(winner|champion|co_?win)')`)
  assert.deepEqual(columns, [], 'no column records a winner')
  assert.equal(await scalar(`select count(*)::int from audit_log where message ~* '(winner|champion)'`), 0)
  assert.equal(await scalar(`select count(*)::int from pools where status not in ('open','closed','active','archived','completed','draft')`), 0)
  console.log(`PASS ${schema}: no winner column or row`)
}

// ---- advanceSlate reports the stop (real contest_state, stubbed network) and resumes after a restore -------
async function loadTs(file, dependencies = {}) {
  const exports = {}
  const code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'exports', code)((name) => {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected test dependency: ${name}`)
  }, exports)
  return exports
}
{
  await sql('set search_path to public,pg_catalog')
  await reset('public', { mode: 'march-madness' })
  for (const n of [1, 2]) await player(n)
  await slate(1, { date: 'current_date-1', active: true })
  await game(1, 1, 'A', 'B', { round: '1st Round' })
  await pick(1, 1, 'B'); await pick(2, 1, 'B')
  await setResult(1, 'home_win'); await regrade(1)
  const slateRow = { id: SL(1), slate_number: 1, slate_date: '2000-01-01', season_year: 2027 }
  const supabase = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: slateRow, error: null }), single: async () => ({ data: { auto_assign_completed_at: null }, error: null }) }) }) }),
    rpc: async (name) => (name === 'contest_state' ? { data: await scalar('select contest_state()'), error: null } : { data: null, error: null }),
  }
  const calls = []
  const { advanceSlate } = await loadTs('src/lib/advanceSlate.ts', {
    'next/server': { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/revalidateContest': { revalidateContest: () => {} },
    '@/lib/espnSync': { syncSlateFromEspn: async () => ({ ok: true }) },
    '@/lib/audit': { logAudit: async () => {} },
    '@/lib/grading': { gradeSlatePicks: async () => ({ eliminated: [], advanced: [] }) },
    '@/lib/autoAssign': { runAutoAssignNow: async () => { calls.push('assign'); return { ok: false } } },
    '@/lib/seasonData': {
      loadGamesForSlates: async () => [{ id: G(1), result: 'home_win', home_team: 'A', away_team: 'B' }],
      loadPicksForSlates: async () => [],
    },
    '@/lib/alerts': { serverError: async (_s, err) => ({ body: { error: String(err) }, status: 500 }) },
    'node:crypto': { randomUUID },
    '@/lib/advanceSchedule': { isAdvanceWindow: () => true },
    '@/lib/operationPolicy': { centralClock: () => ({ date: '2100-01-01' }) },
    '@/lib/pool': { getPoolConfig: async () => ({ competition_mode: await scalar('select competition_mode from pools where is_active') }) },
  })
  const stopped = await advanceSlate(supabase, new Date(), 'system')
  assert.equal(stopped.status, 200); assert.equal(stopped.body.stopped, true)
  assert.match(stopped.body.message, /no entries alive/)
  assert.deepEqual(calls, [], 'a stopped contest does not wait or assign')
  await sql(`select restore_player('${P(1)}','Admin restored','test-admin')`)
  const resumed = await advanceSlate(supabase, new Date(), 'system')
  assert.notEqual(resumed.body.stopped, true); assert.deepEqual(calls, ['assign'], 'advancement resumes once an entry is alive')
  console.log('PASS advanceSlate: stopped state is a normal non-error result; restoring an entry resumes advancement')
}

// ---- ESPN sync keeps an administrator result (real espnSync.ts against a stub feed) ---------------------------
{
  const espn = await loadTs('src/lib/espn.ts', { 'server-only': {} })
  const paging = await loadTs('src/lib/db.ts')
  const teams = await loadTs('src/lib/teams.ts', { './db': paging })
  let feed
  const { syncSlateFromEspn } = await loadTs('src/lib/espnSync.ts', {
    'server-only': {}, 'node:crypto': { randomUUID }, './db': paging, './teams': teams,
    './espn': { ...espn, fetchDayScoreboard: async () => feed, fetchApRankings: async () => ({}) },
    './slates': { getOrCreateSlate: async () => ({ id: 'slate' }), refreshLockTime: async () => {}, renumberSlates: async () => {} },
  })
  const final = {
    id: 'event', date: '2026-11-01T20:00:00Z',
    competitions: [{ timeValid: true, status: { type: { name: 'STATUS_FINAL', state: 'post', completed: true } },
      competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'A' }, score: '70', winner: false },
        { homeAway: 'away', team: { id: '2', abbreviation: 'B' }, score: '78', winner: true }] }],
  }
  const stub = (source) => {
    const state = { games: [{ id: 'g', espn_event_id: 'event', slate_id: 'slate', home_team: 'A', away_team: 'B', home_team_id: '1', away_team_id: '2', result: 'home_win', result_source: source }],
      slates: [{ id: 'slate', slate_date: '2026-11-01', is_active: true }], picks: [], teams: [] }
    return {
      state, async rpc() { return { error: null } },
      from(table) {
        let action, payload, window
        const query = { select: () => query, eq: () => query, in: () => query, order: () => query, range(from, to) { window = [from, to]; return query }, or: () => query,
          upsert(v) { action = 'upsert'; payload = v; return query }, update(v) { action = 'update'; payload = v; return query },
          insert(v) { state[table].push(v); return query }, delete: () => query,
          async maybeSingle() { return { data: state[table][0] ?? null, error: null } },
          then(resolve, reject) { return exec().then(resolve, reject) } }
        async function exec() {
          if (action === 'upsert') {
            const rows = payload.map((row) => { const old = state[table].find((o) => o.espn_event_id === row.espn_event_id); if (old) { Object.assign(old, row); return old } state[table].push({ id: 'n', ...row }); return row })
            return { data: structuredClone(rows), error: null }
          }
          const rows = window ? state[table].slice(window[0], window[1] + 1) : state[table]
          return { data: structuredClone(rows), error: null }
        }
        return query
      },
    }
  }
  process.env.TOURNAMENT_RELIABILITY_ENABLED = 'true'
  feed = { events: [final], failedGroups: [] }
  const manual = stub('admin')
  assert.equal((await syncSlateFromEspn(manual, '20261101', 2026)).ok, true)
  assert.equal(manual.state.games[0].result, 'home_win', 'a manual result is not overwritten')
  assert.equal(manual.state.games[0].home_score, 70, 'scores still refresh')
  const normal = stub('espn')
  await syncSlateFromEspn(normal, '20261101', 2026)
  assert.equal(normal.state.games[0].result, 'away_win', 'an ESPN result is still updated by ESPN')
  console.log('PASS espnSync: manual results are kept, ESPN-sourced results still follow the feed')
}

// ---- Regular season keeps the calendar moving with nobody alive; March Madness still stops -----------------
{
  await sql('set search_path to public,pg_catalog')
  const saved = [process.env.AUTOMATION_V2_ENABLED, process.env.TOURNAMENT_RELIABILITY_ENABLED]
  process.env.AUTOMATION_V2_ENABLED = 'true'; process.env.TOURNAMENT_RELIABILITY_ENABLED = 'true'
  const slateRow = { id: SL(1), slate_number: 1, slate_date: '2000-01-01', season_year: 2027 }
  async function advanceWith(mode, restore) {
    await reset('public', { mode })
    for (const n of [1, 2]) await player(n)
    await slate(1, { date: 'current_date-1', active: true })
    await game(1, 1, 'A', 'B', { round: mode === 'march-madness' ? '1st Round' : null })
    await pick(1, 1, 'B'); await pick(2, 1, 'B')
    await setResult(1, 'home_win'); await regrade(1)
    if (restore) await sql(`select restore_player('${P(1)}','Admin restored','test-admin')`)
    const rpcs = []
    const supabase = {
      // The next day's deadline has already passed, as in the stuck production case.
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: slateRow, error: null }), single: async () => ({ data: { auto_assign_completed_at: 'done', locks_at: '2000-01-02T00:00:00Z' }, error: null }) }) }) }),
      rpc: async (name, args) => { rpcs.push([name, args]); return name === 'contest_state' ? { data: await scalar('select contest_state()'), error: null } : { data: null, error: null } },
    }
    const { advanceSlate } = await loadTs('src/lib/advanceSlate.ts', {
      'next/server': { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
      '@/lib/revalidateContest': { revalidateContest: () => {} },
      '@/lib/espnSync': { syncSlateFromEspn: async () => ({ ok: true, slateId: 'next-day', gamesSynced: 3, reviewGames: [] }) },
      '@/lib/audit': { logAudit: async () => {} },
      '@/lib/grading': { gradeSlatePicks: async () => ({ eliminated: [], advanced: [] }) },
      '@/lib/autoAssign': { runAutoAssignNow: async () => ({ ok: true, done: true }) },
      '@/lib/seasonData': { loadGamesForSlates: async () => [{ id: G(1), result: 'home_win', home_team: 'A', away_team: 'B' }], loadPicksForSlates: async () => [] },
      '@/lib/alerts': { serverError: async (_s, err) => ({ body: { error: String(err) }, status: 500 }) },
      'node:crypto': { randomUUID },
      '@/lib/advanceSchedule': { isAdvanceWindow: () => true },
      '@/lib/operationPolicy': { centralClock: () => ({ date: '2100-01-01' }) },
      '@/lib/pool': { getPoolConfig: async () => ({ competition_mode: await scalar('select competition_mode from pools where is_active') }) },
    })
    const response = await advanceSlate(supabase, new Date(), 'system')
    return { response, rpcs, names: rpcs.map(([name]) => name) }
  }
  const idle = await advanceWith('regular-season', false)
  assert.equal(JSON.parse(await scalar('select contest_state()::text')).stopped, true, 'precondition: nobody alive after the start')
  assert.equal(idle.response.body.advanced_to, '2000-01-02', 'regular season: the calendar moves with nobody alive')
  assert.equal(idle.response.body.stopped, undefined)
  assert.ok(!idle.names.includes('record_incident'), 'no incident when nobody is alive to miss a deadline')
  assert.equal(idle.rpcs.find(([name]) => name === 'activate_ready_slate')[1].p_require_open, false, 'the already-passed deadline does not block the move')
  const live = await advanceWith('regular-season', true)
  assert.equal(live.response.body.waiting, true, 'with an entry alive a missed deadline still needs organizer review')
  assert.ok(live.names.includes('record_incident') && !live.names.includes('activate_ready_slate'))
  const bracket = await advanceWith('march-madness', false)
  assert.equal(bracket.response.body.stopped, true, 'march madness: zero survivors still stops progression')
  assert.ok(!bracket.names.includes('activate_ready_slate') && !bracket.names.includes('record_incident'))
  process.env.AUTOMATION_V2_ENABLED = saved[0] ?? ''; process.env.TOURNAMENT_RELIABILITY_ENABLED = saved[1] ?? ''
  console.log('PASS advanceSlate: regular season advances with nobody alive (no incident); entry alive keeps the review rule; March Madness zero survivors still stops')
}

// ---- A day skipped by "Jump to the current day" never assigns or eliminates anyone -------------------------
for (const schema of ['public', 'sandbox']) {
  await reset(schema)
  for (const n of [1, 2, 3]) await player(n)
  await slate(1, { date: 'current_date-3', locks: "now()-interval '3 days'" })       // earlier day with results
  await slate(2, { date: 'current_date-2', locks: "now()-interval '2 days'" })       // a missed day: never active again
  await slate(3, { date: 'current_date+1', active: true, locks: "now()+interval '20 hours'" })
  await game(1, 1, 'A', 'B', { tip: "now()-interval '3 days'" }); await game(2, 2, 'C', 'D', { tip: "now()-interval '2 days'" })
  await game(3, 3, 'E', 'F', { tip: "now()+interval '20 hours'" })
  await pick(2, 1, 'A')
  await setResult(1, 'home_win'); await setResult(2, 'home_win')
  const incidentsBefore = await scalar('select count(*)::int from incidents')
  // Entries 1 and 3 have no pick on the skipped days 1 and 2. Everything that grades, re-checks or reminds runs.
  await regrade(1); await regrade(2)
  await sql('select reconcile_contest()')
  const reminded = await scalar(`select queue_pick_reminders('${SL(3)}',array['${P(1)}','${P(2)}','${P(3)}']::uuid[],array['${SL(3)}']::uuid[],1,now()+interval '20 hours','tomorrow')`)
  assert.ok(reminded >= 0)
  assert.equal(await scalar(`select count(*)::int from players where status='alive'`), 3, `${schema}: nobody is eliminated for having no pick on a skipped day`)
  assert.equal(await scalar(`select count(*)::int from picks where slate_id in ('${SL(1)}','${SL(2)}') and player_id in ('${P(1)}','${P(3)}')`), 0, `${schema}: entries with no pick on a skipped day are given none`)
  assert.equal(await scalar(`select count(*)::int from audit_log where event_type='player-eliminated'`), 0)
  assert.equal(await scalar('select count(*)::int from incidents'), incidentsBefore, `${schema}: no incident is raised`)
  // With nobody alive, reminders write nothing at all.
  await sql(`update players set status='eliminated',elimination_reason='x',elimination_slate=1`)
  const none = await scalar(`select queue_pick_reminders('${SL(3)}',array['${P(1)}','${P(2)}','${P(3)}']::uuid[],array['${SL(3)}']::uuid[],1,now()+interval '20 hours','tomorrow')`)
  assert.equal(none, 0)
  console.log(`PASS ${schema}: skipped days are never assigned or eliminated for; reminders with nobody alive write nothing`)
}

// ---- Incident recovery: job problems close when the job succeeds; human decisions never auto-close ------------
{
  await sql('set search_path to public,pg_catalog')
  await reset('public')
  await sql('truncate incidents,operation_runs cascade')
  const incidentText = await loadTs('src/lib/incidentText.ts')
  const builder = (table) => {
    const state = { op: 'select', cols: '*', set: null, filters: [], list: null, ret: '*' }
    const self = {
      select(cols) { if (state.op === 'update') state.ret = cols; else state.cols = cols; return self },
      update(values) { state.op = 'update'; state.set = values; return self },
      eq(column, value) { state.filters.push([column, value]); return self },
      in(column, values) { state.list = [column, values]; return self },
      then(resolve, reject) { return run().then(resolve, reject) },
    }
    async function run() {
      const params = [], where = []
      for (const [column, value] of state.filters) { params.push(value); where.push(`${column}=$${params.length}`) }
      if (state.list) { params.push(state.list[1]); where.push(`${state.list[0]}=any($${params.length})`) }
      const clause = where.length ? ` where ${where.join(' and ')}` : ''
      try {
        if (state.op === 'update') { const [column, value] = Object.entries(state.set)[0]; params.push(value); return { data: (await db.query(`update ${table} set ${column}=$${params.length}${clause} returning ${state.ret}`, params)).rows, error: null } }
        return { data: (await db.query(`select ${state.cols} from ${table}${clause}`, params)).rows, error: null }
      } catch (error) { return { data: null, error } }
    }
    return self
  }
  const fake = { from: builder }
  const incidents = await loadTs('src/lib/incidents.ts', {
    'server-only': {}, './incidentText': incidentText,
    './audit': { logAudit: async (_db, entry) => { await db.query(`insert into audit_log(event_type,actor,message,details) values($1,$2,$3,$4)`, [entry.event_type, entry.actor, entry.message, JSON.stringify(entry.details ?? {})]) } },
  })
  const record = (key) => sql(`select record_incident('${key}','raw impact',gen_random_uuid(),'detail')`)
  const open = async () => (await q(`select key from incidents where status='open' order by key`)).map((row) => row.key)
  const HUMAN = ['turnover-missed:2026-11-13', 'wrongly-eliminated:abc:3', 'result-review:g1', 'schedule-sync:2026-11-12', 'schedule-change:g2']
  for (const key of ['api/cron/worker/results', 'api/cron/sync-results', 'api/cron/worker/grading', ...HUMAN]) await record(key)
  await record('api/cron/worker/results'); await record('api/cron/worker/results')
  assert.equal(await scalar(`select occurrences from incidents where key='api/cron/worker/results'`), 3)

  await incidents.resolveRecoveredForWorkload(fake, 'results')
  assert.deepEqual(await open(), ['api/cron/worker/grading', ...HUMAN].sort(), 'only the results job incidents recover')
  assert.equal(await auditCount('incident-resolved'), 1)
  assert.match(await scalar(`select message from audit_log where event_type='incident-resolved'`), /Recovered: the job has run successfully since/)

  await record('api/cron/worker/results')
  assert.ok((await open()).includes('api/cron/worker/results'), 'the same problem happening again reopens it')

  for (const workload of ['results', 'grading', 'assignment', 'advance', 'schedule', 'reminders', 'integrity', 'retention', 'campaigns', 'delivery']) await incidents.resolveRecoveredForWorkload(fake, workload)
  assert.deepEqual(await open(), [...HUMAN].sort(), 'incidents that need a human decision stay open whatever the jobs do')

  // The one-click clean-up of old rows: only job incidents whose job succeeded after they last happened.
  await record('api/cron/worker/advance'); await record('api/cron/worker/schedule')
  await sql(`update incidents set latest_at=now()-interval '3 days' where key like 'api/cron/%' or key like 'turnover-missed:%'`)
  await sql(`insert into operation_runs(key,status,last_success_at) values('recurring:advance','pending',now()),('recurring:schedule','pending',now()-interval '10 days')`)
  assert.deepEqual(await incidents.recoveredIncidentKeys(fake), ['api/cron/worker/advance'])
  assert.equal(await incidents.resolveMany(fake, await incidents.recoveredIncidentKeys(fake), 'Old problems'), 1)
  assert.ok((await open()).includes('api/cron/worker/schedule') && (await open()).includes('turnover-missed:2026-11-13'))
  assert.equal(await incidents.resolveIncident(fake, 'result-review:g1', 'Checked'), true)
  assert.equal(await incidents.resolveIncident(fake, 'result-review:g1', 'Checked'), false, 'already resolved')
  assert.equal(await incidents.resolveByPrefix(fake, 'turnover-missed:', 'Jump'), 1)
  console.log('PASS incidents: recovered job problems auto-resolve, human-decision ones stay open, clear and resolve are audited')
}
await db.close()
