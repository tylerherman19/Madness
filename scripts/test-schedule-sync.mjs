import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

async function loadTs(file, dependencies = {}) {
 const exports = {}
 const code = ts.transpileModule(await readFile(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText
 new Function('require', 'exports', code)(name => {
  if (name in dependencies) return dependencies[name]
  throw new Error(`Unexpected test dependency: ${name}`)
 }, exports)
 return exports
}
const espn = await loadTs('src/lib/espn.ts', {'server-only': {}})
const paging = await loadTs('src/lib/db.ts')
let feed, hooks
const { syncSlateFromEspn } = await loadTs('src/lib/espnSync.ts', {
 'server-only': {}, 'node:crypto': {randomUUID}, './db': paging,
 './espn': {...espn, fetchDayScoreboard: async () => feed, fetchApRankings: async () => ({})},
 './slates': {
  getOrCreateSlate: async (_db, date) => {hooks.push(['create', date]); return {id: 'new-slate'}},
  refreshLockTime: async (_db, id) => hooks.push(['lock', id]),
  renumberSlates: async () => hooks.push(['renumber']),
 },
})
const event = (date = '2026-11-01T20:00:00Z', extra = {}) => ({
 id: 'event', date, competitions: [{timeValid: true, status: {type: {state: 'pre', completed: false}},
  competitors: [{homeAway: 'home', team: {id: '1', abbreviation: 'A'}}, {homeAway: 'away', team: {id: '2', abbreviation: 'B'}}]}], ...extra,
})
// The response cap is deliberately TWO rows: use the real paging helper, and
// ensure a picked period is found even when the first response is truncated.
function fixture({games = [], slates = [], picks = [], directoryError = false, skipUpsert = false, legacy = false} = {}) {
 const state = {games: structuredClone(games), slates: structuredClone(slates), picks: structuredClone(picks), teams: [], audit_log: []}
 const calls = [], incidents = []
 return {state, calls, incidents,
  async rpc(name, args) {incidents.push({name, args}); return {error: null}},
  from(table) {
   const filters = []; let action, payload, conflict, columns, range
   const query = {
    select(value) {if (legacy) assert.doesNotMatch(value, /home_team_id|away_team_id|game_id/); columns = value; return query},
    eq(key, value) {filters.push(row => row[key] === value); return query},
    in(key, values) {filters.push(row => values.includes(row[key])); return query},
    order() {return query}, range(from, to) {range = [from, to]; return query},
    or() {return query},
    upsert(value, options) {action = 'upsert'; payload = value; conflict = options.onConflict; return query},
    update(value) {action = 'update'; payload = value; return query},
    insert(value) {action = 'insert'; payload = value; return query},
    delete() {action = 'delete'; return query},
    async maybeSingle() {const result = await execute(); return {...result, data: result.data?.[0] ?? null}},
    then(resolve, reject) {return execute().then(resolve, reject)},
   }
   async function execute() {
    calls.push({table, action, columns})
    let rows = state[table].filter(row => filters.every(filter => filter(row)))
    if (action === 'upsert') {
     if (table === 'teams' && directoryError) return {data: null, error: {message: 'Fixture directory failure'}}
     rows = []
     for (const row of payload) {
      if (table === 'games' && skipUpsert) continue
      const existing = state[table].find(old => old[conflict] === row[conflict])
      if (existing) {Object.assign(existing, row); rows.push(existing)}
      else {const saved = {id: randomUUID(), ...row}; state[table].push(saved); rows.push(saved)}
     }
    } else if (action === 'insert') {state[table].push(payload); rows = [payload]}
    else if (action === 'update') rows.forEach(row => Object.assign(row, payload))
    else if (action === 'delete') state[table] = state[table].filter(row => !rows.includes(row))
    else rows = range ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + 2)) : rows.slice(0, 2)
    return {data: structuredClone(rows), error: null}
   }
   return query
  },
 }
}
async function run(client, events, failedGroups = []) {
 hooks = []; feed = {events, failedGroups}
 return syncSlateFromEspn(client, '20261101', 2026)
}
const oldFlag = process.env.TOURNAMENT_RELIABILITY_ENABLED
const oldAutomation = process.env.AUTOMATION_V2_ENABLED
process.env.TOURNAMENT_RELIABILITY_ENABLED = 'true'
process.env.AUTOMATION_V2_ENABLED = 'false'
try {
 for (const events of [[event('2026-11-02T20:00:00Z')], [event(), event('2026-11-02T20:00:00Z', {id: 'wrong'})], [event('invalid')], [event(undefined, {competitions: []})]]) {
  const client = fixture()
  const result = await run(client, events)
  assert.equal(result.ok, false); assert.ok(result.partial.length)
  assert.equal(client.calls.length, 0, 'An incomplete date response must make no database reads or writes')
  assert.equal(hooks.length, 0)
 }
 for (const item of [event('2026-11-02T03:00:00Z'), event('2026-11-01T04:00:00Z', {competitions: [{...event().competitions[0], timeValid: false}]})]) {
  const client = fixture()
  assert.equal((await run(client, [item])).ok, true, 'Late UTC tips and Eastern TBD placeholders remain supported')
  assert.equal(client.state.games[0].slate_id, 'new-slate')
 }
 const oldGame = {id: 'game', espn_event_id: 'event', slate_id: 'old-slate', home_team: 'A', away_team: 'B', home_team_id: '1', away_team_id: '2', result: 'pending'}
 for (const legacy of [false, true]) {
  process.env.TOURNAMENT_RELIABILITY_ENABLED = String(!legacy)
  const client = fixture({legacy, games: [oldGame], slates: [{id: 'old-slate', slate_date: '2026-10-31'}], picks: [0,1,2].map(n => ({id: String(n), slate_id: 'old-slate', team: 'A'}))})
  const result = await run(client, [event()])
  assert.equal(result.ok, false); assert.ok(result.partial.includes('schedule-review'))
  assert.deepEqual(client.state.games, [oldGame]); assert.equal(hooks.length, 0)
  assert.equal(legacy ? client.state.audit_log.length : client.incidents.length, 1)
  assert.equal(client.calls.filter(call => call.table === 'picks').length, 3, 'Pick review reads every capped page')
 }
 process.env.TOURNAMENT_RELIABILITY_ENABLED = 'true'
 const raced = fixture({games: [oldGame], slates: [{id: 'old-slate', slate_date: '2026-10-31'}], skipUpsert: true})
 assert.equal((await run(raced, [event()])).ok, false, 'A trigger-skipped concurrent move must never report success')
 assert.deepEqual(raced.state.games, [oldGame])
 const directory = fixture({directoryError: true})
 assert.match((await run(directory, [event()])).error, /Failed to save team directory/)
 const partial = fixture({games: [{...oldGame, id: 'other', espn_event_id: 'absent', slate_id: 'new-slate'}]})
 assert.equal((await run(partial, [event()], ['SEC'])).ok, true)
 assert.ok(partial.state.games.some(game => game.id === 'other'), 'A failed conference must disable pruning')
 console.log('PASS schedule sync: wrong/mixed/invalid date fail closed, Central late tip, TBD placeholder, paged picked move, legacy audit, concurrent guard skip, directory failure and incomplete-feed preservation')
} finally {
 if (oldFlag === undefined) delete process.env.TOURNAMENT_RELIABILITY_ENABLED; else process.env.TOURNAMENT_RELIABILITY_ENABLED = oldFlag
 if (oldAutomation === undefined) delete process.env.AUTOMATION_V2_ENABLED; else process.env.AUTOMATION_V2_ENABLED = oldAutomation
}

const db = new PGlite()
await db.exec('create role anon;create role authenticated;create role service_role;create role authenticator;')
for (const file of (await readdir('supabase/migrations')).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
await db.exec(await readFile('supabase/migrations/028_schedule_identity_guard.sql', 'utf8'))
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0]
for (const schema of ['public', 'sandbox']) {
 await db.exec(`set search_path=${schema},pg_catalog;
  update pools set season_year=2099,competition_mode='regular-season',pick_frequency='every-game-day';
  insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at) values
   ('00000000-0000-4000-8000-000000000001',1,'2099-03-19',2099,true,'2099-03-19T18:00:00Z'),
   ('00000000-0000-4000-8000-000000000002',2,'2099-03-20',2099,false,'2099-03-20T18:00:00Z');
  insert into games(espn_event_id,slate_id,home_team,away_team,tip_time) values('move','00000000-0000-4000-8000-000000000002','C','D','2099-03-20T18:00:00Z');
  update games set slate_id='00000000-0000-4000-8000-000000000001' where espn_event_id='move';`)
 assert.equal(await scalar(`select jsonb_array_length(assignment_schedule) from slates where slate_number=2`), 0, 'Unpicked move removes OLD assignment snapshot entry')
 assert.equal(await scalar(`select jsonb_array_length(assignment_schedule) from slates where slate_number=1`), 1)
 await db.exec(`insert into players(full_name,email,pin_hash)values('Fixture','fixture@example.test','fixture');
  insert into picks(player_id,slate_id,team)select id,'00000000-0000-4000-8000-000000000001','C' from players;
  update games set home_team_id='stable-C',away_team_id='stable-D' where espn_event_id='move';`)
 const game = await scalar(`select to_jsonb(g) from games g where espn_event_id='move'`)
 for (const change of ["slate_id='00000000-0000-4000-8000-000000000002',result='away_win'", "home_team='OTHER'", "home_team_id='OTHER'", "espn_event_id='renamed'", "id=gen_random_uuid()"]) {
  assert.equal((await db.query(`update games set ${change} where espn_event_id='move' returning id`)).rows.length, 0)
  assert.deepEqual(await scalar(`select to_jsonb(g) from games g where espn_event_id='move'`), game)
 }
 assert.equal((await db.query(`delete from games where espn_event_id='move' returning id`)).rows.length, 0)
 assert.equal(await scalar(`select count(*)::int from incidents where key=$1 and status='open'`, [`schedule-change:${game.id}`]), 1)
 assert.equal(await scalar(`select occurrences from incidents where key=$1`, [`schedule-change:${game.id}`]), 6)
 assert.equal(await scalar(`select game_id from picks`), game.id)
 await db.exec(`update games set home_score=10,status_state='in' where espn_event_id='move'`)
 assert.equal(await scalar(`select home_score from games where espn_event_id='move'`), 10, 'Normal live score updates still work')
 assert.equal(await scalar(`select has_function_privilege('anon',$1,'EXECUTE')`, [`${schema}.guard_picked_schedule()`]), false)
 console.log(`PASS ${schema}: idempotent 028, unpicked move snapshots, legacy stable-ID fill, protected period/team/provider/game identity and delete, preserved outcome/linkage, live scores and restricted trigger ACL`)
}
await db.close()
