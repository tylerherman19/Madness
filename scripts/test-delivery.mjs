// Mocked provider fault injection; this is functional evidence, not provider capacity.
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import assert from 'node:assert/strict'
function module(code, deps = {}) {
  const exports = {}
  new Function(
    'require',
    'exports',
    ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )((name) => {
    if (name in deps) return deps[name]
    throw new Error(name)
  }, exports)
  return exports
}
const policy = module(await readFile('src/lib/deliveryPolicy.ts', 'utf8'))
const events = [
  {
    id: 'message-1',
    kind: 'announcement',
    payload: { subject: 'original' },
    recipient: 'fixture@example.com',
    player_id: null,
    lease_token: 'token',
    attempts: 0,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    frozen_request: null,
  },
]
let frozen,
  attempts = 0,
  settles = [],
  claimed = true,
  slot = true
const settings = { mode: 'live', allowlist: [], paused_until: null }
const db = {
  from() {
    const q = {
      select() {
        return q
      },
      eq() {
        return q
      },
      update(value) {
        Object.assign(settings, value)
        return q
      },
      async single() {
        return { data: settings, error: null }
      },
      async maybeSingle() {
        return { data: null, error: null }
      },
      then(resolve) {
        resolve({ data: null, error: null })
      },
    }
    return q
  },
  async rpc(name, args) {
    if (name === 'claim_notifications') {
      const data = claimed ? events : []
      claimed = false
      return { data, error: null }
    }
    if (name === 'reserve_email_slot') return { data: slot, error: null }
    if (name === 'prepare_notification') {
      frozen ??= args.p_request
      attempts++
      return { data: frozen, error: null }
    }
    if (name === 'settle_notification') {
      settles.push(args)
      return { data: true, error: null }
    }
    throw new Error(name)
  },
}
const { deliverNotifications } = module(
  await readFile('src/lib/notificationWorker.ts', 'utf8'),
  {
    'server-only': {},
    './delivery': {
      openRequest: (r) => r,
      renderNotification: (e) => ({
        from: 'sender@example.com',
        to: e.recipient,
        subject: e.payload.subject,
        text: 'Frozen text',
      }),
    },
    './deliveryPolicy': policy,
    './competition': {},
    './seasonData': {},
    './pool': {},
  },
)
const original = globalThis.fetch
process.env.EMAILS_ENABLED = 'false'
process.env.OUTBOX_DELIVERY_ENABLED = 'true'
process.env.RESEND_API_KEY = 'fixture'
assert.equal((await deliverNotifications(db)).disabled, true)
assert.equal(attempts, 0)
process.env.EMAILS_ENABLED = 'true'
const requests = []
try {
  globalThis.fetch = async (url, init) => {
    requests.push(init)
    throw new Error('Provider accepted; HTTP response lost')
  }
  await deliverNotifications(db)
  assert.equal(settles.at(-1).p_status, 'pending')
  events[0].payload.subject = 'rebuilt different content'
  events[0].attempts = 1
  claimed = true
  globalThis.fetch = async (url, init) => {
    requests.push(init)
    return Response.json({ id: 'provider-1' })
  }
  assert.equal((await deliverNotifications(db)).accepted, 1)
  assert.equal(requests[0].body, requests[1].body)
  assert.equal(
    requests[0].headers['Idempotency-Key'],
    requests[1].headers['Idempotency-Key'],
  )
  assert.equal(settles.at(-1).p_status, 'sent')
  claimed = true
  settings.mode = 'record-only'
  await deliverNotifications(db)
  assert.equal(requests.length, 2)
  assert.equal(policy.deliveryFailure(429, 'rate_limit', 1, '120').delay, 120)
  assert.equal(
    policy.deliveryFailure(400, 'invalid_recipient', 1).state,
    'review',
  )
  assert.equal(policy.deliveryFailure(403, 'quota_exhausted', 1).pause, true)
  assert.equal(policy.deliveryFailure(429, 'daily_quota_exhausted', 1).state, 'review')
  assert.equal(
    policy.deliveryFailure(503, 'provider_unavailable', 1).state,
    'pending',
  )
  console.log(
    'PASS mocked provider: master switch, record-only gate, lost acceptance response, frozen content/idempotency, rate limit, permanent failure, configuration pause',
  )
} finally {
  globalThis.fetch = original
}
