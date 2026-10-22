// No credentials or production defaults. A supplied fixture must contain staging-only sessions.
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
const target = new URL(process.env.LOAD_TEST_URL ?? 'http://127.0.0.1:3017')
if (
  process.env.LOAD_TEST_ACK !== 'ISOLATED_STAGING' ||
  target.hostname === 'madness-cyan.vercel.app' ||
  !['http:', 'https:'].includes(target.protocol)
)
  throw new Error(
    'Explicit isolated staging acknowledgement required; production host is blocked',
  )
const fixtures = process.env.LOAD_TEST_FIXTURES
  ? JSON.parse(await readFile(process.env.LOAD_TEST_FIXTURES, 'utf8'))
  : []
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 1000),
  duration = Number(process.env.LOAD_TEST_SECONDS ?? 30)
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 2000 ||
  duration < 1 ||
  duration > 600
)
  throw new Error('Invalid load bounds')
const mode = process.env.LOAD_TEST_MODE ?? 'view',
  latencies = [],
  statuses = {}
if (mode === 'pick' && fixtures.length < 2000)
  throw new Error(
    'Provide at least 2000 isolated entry fixtures for pick traffic',
  )
const started = performance.now(),
  end = started + duration * 1000
await Promise.all(
  Array.from({ length: concurrency }, async (_, worker) => {
    let sequence = 0
    while (performance.now() < end) {
      const began = performance.now(),
        fixture = fixtures[(worker + sequence * concurrency) % fixtures.length]
      try {
        const response = await fetch(
          new URL(mode === 'pick' ? '/api/picks' : '/standings', target),
          mode === 'pick'
            ? {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Cookie: fixture.cookie,
                },
                body: JSON.stringify({
                  ...fixture.pick,
                  request_id: fixture.requestId,
                }),
                signal: AbortSignal.timeout(15000),
              }
            : { signal: AbortSignal.timeout(15000) },
        )
        await response.arrayBuffer()
        statuses[response.status] = (statuses[response.status] ?? 0) + 1
      } catch {
        statuses.network = (statuses.network ?? 0) + 1
      }
      latencies.push(performance.now() - began)
      sequence++
    }
  }),
)
latencies.sort((a, b) => a - b)
const pct = (p) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ??
  null
const report = {
  environment: target.origin,
  mode,
  datasetEntries: fixtures.length,
  concurrency,
  durationSeconds: (performance.now() - started) / 1000,
  requests: latencies.length,
  statuses,
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
}
console.log(JSON.stringify(report, null, 2))
if (process.env.LOAD_TEST_REPORT)
  await writeFile(process.env.LOAD_TEST_REPORT, JSON.stringify(report, null, 2))
