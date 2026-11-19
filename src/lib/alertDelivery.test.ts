import test from 'node:test'
import assert from 'node:assert/strict'
import { alertLane, alertRecipients, sendAlertsDirect } from './alertDelivery.ts'

const PHONE = '5551234567@tmomail.net'

test('production sends alerts directly without the player-mail switches', () => {
  const lane = alertLane({ ALERT_SMS_TO: PHONE, RESEND_API_KEY: 're_x', VERCEL_ENV: 'production' })
  assert.equal(lane.direct, true)
  assert.deepEqual(lane.recipients, [PHONE])
})

test('previews and local development only record alerts unless explicitly enabled', () => {
  assert.equal(alertLane({ ALERT_SMS_TO: PHONE, RESEND_API_KEY: 're_x', VERCEL_ENV: 'preview' }).direct, false)
  assert.equal(alertLane({ ALERT_SMS_TO: PHONE, RESEND_API_KEY: 're_x' }).direct, false)
  assert.equal(alertLane({ ALERT_SMS_TO: PHONE, RESEND_API_KEY: 're_x', OPERATIONAL_ALERTS_ENABLED: 'true' }).direct, true)
})

test('the off switch wins in production, and missing settings say why', () => {
  const off = alertLane({ ALERT_SMS_TO: PHONE, RESEND_API_KEY: 're_x', VERCEL_ENV: 'production', OPERATIONAL_ALERTS_ENABLED: 'false' })
  assert.equal(off.direct, false)
  assert.match(off.direct ? '' : off.reason, /switched off/)
  const noKey = alertLane({ ALERT_SMS_TO: PHONE, VERCEL_ENV: 'production' })
  assert.match(noKey.direct ? '' : noKey.reason, /RESEND_API_KEY/)
  const noTo = alertLane({ RESEND_API_KEY: 're_x', VERCEL_ENV: 'production' })
  assert.match(noTo.direct ? '' : noTo.reason, /ALERT_SMS_TO/)
})

test('recipients are trimmed, deduplicated and must look like addresses', () => {
  assert.deepEqual(alertRecipients(` ${PHONE}, ${PHONE},not-an-address, ops@example.com `), [PHONE, 'ops@example.com'])
})

test('each recipient gets one request with a stable idempotency key', async () => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ id: `msg-${calls.length}` }), { status: 200 })
  }) as unknown as typeof fetch
  const lane = alertLane({ ALERT_SMS_TO: `${PHONE},ops@example.com`, RESEND_API_KEY: 're_x', VERCEL_ENV: 'production' })
  assert.equal(lane.direct, true)
  if (!lane.direct) return
  const outcomes = await sendAlertsDirect(lane, { from: 'A <a@example.com>', subject: 'Pick and Pray', text: 'job failed', key: 'k1' }, fakeFetch)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].headers.Authorization, 'Bearer re_x')
  assert.equal(calls[0].headers['Idempotency-Key'], `madness-alert/k1/${PHONE}`)
  assert.deepEqual(calls[1].body, { from: 'A <a@example.com>', to: 'ops@example.com', subject: 'Pick and Pray', text: 'job failed' })
  assert.deepEqual(outcomes.map((o) => o.ok), [true, true])
})

test('provider rejections and network errors are reported, not thrown', async () => {
  let n = 0
  const fakeFetch = (async () => {
    n++
    if (n === 1) return new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 })
    throw new Error('network down')
  }) as unknown as typeof fetch
  const lane = alertLane({ ALERT_SMS_TO: `${PHONE},ops@example.com`, RESEND_API_KEY: 're_x', VERCEL_ENV: 'production' })
  if (!lane.direct) return assert.fail('expected direct lane')
  const outcomes = await sendAlertsDirect(lane, { from: 'a@example.com', subject: 's', text: 't', key: 'k' }, fakeFetch)
  assert.deepEqual(outcomes, [{ recipient: PHONE, ok: false, status: 422 }, { recipient: 'ops@example.com', ok: false }])
})
