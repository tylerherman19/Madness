import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { centralClock, reminderWindow } from './operationPolicy.ts'

// The schedule workload must store tomorrow as well as today, so a player
// whose pick wins this afternoon can pick tomorrow's games tonight.
function runSchedule(failing: string[] = []) {
  const synced: string[] = []
  const dependencies: Record<string, unknown> = {
    'server-only': {}, './syncResults': {}, './autoAssign': {}, './advanceSlate': {}, './reminders': {}, './notificationWorker': {},
    './operationPolicy': { centralClock, reminderWindow },
    './espnSync': { syncSlateFromEspn: async (_db: unknown, date: string) => {
      synced.push(date)
      return failing.includes(date) ? { ok: false, error: 'ESPN unavailable' } : { ok: true }
    } },
    './pool': { getPoolConfig: async () => ({ season_year: 2027 }) },
    './grading': {}, './seasonData': {}, './revalidateContest': { revalidateContest() {} },
  }
  const exports: { runTournamentJob?: (db: unknown, kind: string, now: Date) => Promise<unknown> } = {}
  new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('./tournamentJobs.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((name: string) => {
    assert.ok(name in dependencies, `Unexpected test dependency: ${name}`)
    return dependencies[name]
  }, exports)
  const db = { rpc: async (name: string) => ({ data: name === 'claim_operation' ? 'token' : true, error: null }) }
  return { synced, run: () => exports.runTournamentJob!(db, 'schedule', new Date('2026-12-31T20:00:00Z')) }
}

test('the schedule workload syncs today and tomorrow in Central time', async () => {
  const job = runSchedule()
  await job.run()
  assert.deepEqual(job.synced, ['20261231', '20270101'])
})

test('a failed tomorrow fails the workload so it is retried', async () => {
  const job = runSchedule(['20270101'])
  await assert.rejects(job.run(), /ESPN unavailable/)
})
