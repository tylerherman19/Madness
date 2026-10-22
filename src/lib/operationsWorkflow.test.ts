import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Run the actual worker shell block. Replace its two external effects so
// failures exercise Bash's errexit handling without requests or delays.
function runWorker(failedAttempt: number, modern=false) {
  const workflow = readFileSync(new URL('../../.github/workflows/operations.yml', import.meta.url), 'utf8')
  const workerScript = modern ? workflow.split('name: Run an independent workload with durable due times')[1].split('run: |')[1] : workflow.split('name: Run durable work without site visitors')[1].split('tournament-worker:')[0].split('run: |')[1]
  return spawnSync('bash', ['-e', '-c', `
    calls=0
    curl() { calls=$((calls + 1)); test "$calls" != "${failedAttempt}"; }
    node() { calls=$((calls + 1)); test "$calls" != "${failedAttempt}"; }
    sleep() { :; }
    trap 'echo "fixture-calls=$calls"' EXIT
    ${workerScript}
  `], { encoding: 'utf8', env: { ...process.env, CRON_SECRET: 'fixture-only' } })
}

test('worker retries all five minute slots after one failed request and reports failure', () => {
  const result = runWorker(1)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /fixture-calls=5/)
})

test('worker reports success when all five requests succeed', () => {
  const result = runWorker(0)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fixture-calls=5/)
})

test('independent workload shell retains five attempts after a failure without contacting production',()=>{
 const result=runWorker(1,true)
 assert.equal(result.status,1,result.stderr)
 assert.match(result.stdout,/fixture-calls=5/)
})
