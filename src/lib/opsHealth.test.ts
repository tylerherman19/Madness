import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateHealth, type HealthInput } from './opsHealth.ts'

const now = new Date('2026-11-11T18:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()
const healthyJobs = ['schedule', 'results', 'assignment', 'grading', 'advance'].map((k) => ({
  key: `recurring:${k}`, status: 'pending', last_success_at: ago(2), last_error: null,
}))
const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  now, automationEnabled: true, perWorkload: true, jobs: healthyJobs, incidents: [],
  slate: { slate_date: '2026-11-11', deadline: ago(120), auto_assign_completed_at: ago(100) },
  unpicked: 0, attentionCount: 0, contest: { stopped: false, alive: 5 }, databaseOk: true, ...over,
})
const line = (h: ReturnType<typeof evaluateHealth>, id: string) => h.lines.find((l) => l.id === id)!

test('healthy system: every line OK', () => {
  const h = evaluateHealth(base())
  assert.equal(h.overall, 'ok')
  assert.ok(h.lines.every((l) => l.status === 'ok'), JSON.stringify(h.lines))
  assert.equal(h.assignment.state, 'complete')
})

test('a job that has not run past its threshold is Overdue even with no recorded failure', () => {
  const jobs = healthyJobs.map((j) => (j.key === 'recurring:results' ? { ...j, last_success_at: ago(40) } : j))
  const h = evaluateHealth(base({ jobs }))
  assert.equal(line(h, 'results').status, 'overdue')
  assert.equal(line(h, 'results').lastError, null)
  assert.equal(h.overall, 'overdue')
  // A job that never ran at all is also overdue (missing execution).
  const missing = evaluateHealth(base({ jobs: healthyJobs.filter((j) => j.key !== 'recurring:grading') }))
  assert.equal(line(missing, 'grading').status, 'overdue')
})

test('slower workloads get a longer allowance than frequent ones', () => {
  const jobs = healthyJobs.map((j) => (j.key === 'recurring:schedule' ? { ...j, last_success_at: ago(40) } : j))
  assert.equal(line(evaluateHealth(base({ jobs })), 'schedule').status, 'ok')
})

test('a job with a recorded failure is Failing and shows its error', () => {
  const jobs = healthyJobs.map((j) => (j.key === 'recurring:advance' ? { ...j, status: 'failed', last_error: 'Operation failed' } : j))
  const h = evaluateHealth(base({ jobs }))
  assert.equal(line(h, 'advance').status, 'failing')
  assert.equal(line(h, 'advance').lastError, 'Operation failed')
  assert.equal(h.overall, 'failing')
})

test('assignment incomplete after lock is flagged, with a short grace period', () => {
  const slate = { slate_date: '2026-11-11', deadline: ago(60), auto_assign_completed_at: null }
  const h = evaluateHealth(base({ slate, unpicked: 3 }))
  assert.equal(h.assignment.state, 'incomplete')
  assert.equal(line(h, 'assignment-day').status, 'overdue')
  assert.match(line(h, 'assignment-day').detail, /3 alive entries/)
  const fresh = evaluateHealth(base({ slate: { ...slate, deadline: ago(3) }, unpicked: 3 }))
  assert.equal(line(fresh, 'assignment-day').status, 'ok')
  // Before lock nothing is expected.
  assert.equal(evaluateHealth(base({ slate: { ...slate, deadline: ago(-60) }, unpicked: 3 })).assignment.state, 'unlocked')
})

test('stopped contest and stalled results are surfaced', () => {
  const h = evaluateHealth(base({ contest: { stopped: true, alive: 0 }, attentionCount: 2 }))
  assert.equal(h.stopped, true)
  assert.match(line(h, 'contest').detail, /Stopped: no entries alive/)
  assert.equal(line(h, 'contest').status, 'failing')
  assert.match(line(h, 'contest').detail, /2 results need attention/)
})

test('open incidents group by key newest first; closed ones are hidden; weak secret flagged', () => {
  const h = evaluateHealth(base({
    sessionSecret: 'weak',
    incidents: [
      { key: 'a', impact: 'A', status: 'open', occurrences: 40, latest_at: ago(60) },
      { key: 'b', impact: 'B', status: 'open', occurrences: 2, latest_at: ago(5) },
      { key: 'c', impact: 'C', status: 'resolved', occurrences: 9, latest_at: ago(1) },
    ],
  }))
  assert.deepEqual(h.incidents.map((i) => i.key), ['b', 'a'])
  assert.equal(h.incidents[1].occurrences, 40)
  assert.equal(h.weakSecret, true)
})

test('automation off reports Off rather than Overdue', () => {
  const h = evaluateHealth(base({ automationEnabled: false, jobs: [] }))
  assert.equal(line(h, 'results').status, 'off')
  assert.equal(h.overall, 'ok')
})

test('legacy mode uses the worker:* heartbeat only', () => {
  const h = evaluateHealth(base({ perWorkload: false, jobs: [{ key: 'worker:1', status: 'done', last_success_at: ago(30), last_error: null }] }))
  assert.equal(line(h, 'heartbeat').status, 'overdue')
  assert.equal(h.lines.some((l) => l.id === 'results'), false)
})
