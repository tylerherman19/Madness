// Logs only allowlisted diagnostics. Never print authorization headers or player payloads.
const workload = process.argv[2]
const base = process.env.WORKER_BASE_URL ?? 'https://madness-cyan.vercel.app'
if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET required')
const response = await fetch(
  `${base}/api/cron/worker?workload=${encodeURIComponent(workload)}`,
  {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(220000),
  },
)
const body = await response.json().catch(() => ({}))
console.log(
  JSON.stringify({
    workload,
    status: response.status,
    ok: body.ok === true,
    enabled: body.enabled,
    claimed: body.claimed,
    correlationId:
      body.correlationId ?? response.headers.get('x-correlation-id'),
    error: response.ok
      ? undefined
      : 'Workload failed; use correlation ID and System Admin incidents',
  }),
)
if (!response.ok) process.exitCode = 1
