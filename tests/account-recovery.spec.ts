// Organizer-issued recovery links (no email) and shared-network rate limits.
// Test names deliberately avoid the legacy-suite grep: these flows need
// migration 032, while the original "reset link" test covers the fallback.
import { test, expect, type APIRequestContext } from '@playwright/test'
import { SignJWT } from 'jose'
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'

const FIXTURE_DB = `http://127.0.0.1:${process.env.E2E_DB_PORT ?? '54329'}`
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? '3017'}`
const SECRET = new TextEncoder().encode('fixture-only-signing-secret-at-least-32-characters')
const PLAYER = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'
const SLATE = '00000000-0000-4000-8000-000000000001'
const EMAIL = 'player+test@example.test'
const PASSWORD = 'FixturePass123!'

async function adminCookie() {
  const jwt = await new SignJWT({ is_admin: true, purpose: 'admin' }).setJti(crypto.randomUUID())
    .setIssuer('madness').setAudience('madness:local').setIssuedAt().setExpirationTime('1h')
    .setProtectedHeader({ alg: 'HS256' }).sign(SECRET)
  return `survivor_admin=${jwt}`
}
async function issueLink(request: APIRequestContext, player = PLAYER) {
  const response = await request.post(`/api/players/${player}/regen-pin`, { headers: { Cookie: await adminCookie() } })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  const body = await response.json()
  expect(body.emailSent).toBeUndefined()
  const token = new URL(body.resetUrl).hash.match(/^#token=([a-f0-9]{64})$/)?.[1]
  expect(token).toBeTruthy()
  return { ...body, token: token as string }
}
const consume = (request: APIRequestContext, token: string, password: string) =>
  request.post('/api/auth/reset-password', { data: { token, password } })
const db = async (request: APIRequestContext, path: string) => (await request.get(`${FIXTURE_DB}/${path}`)).json()
async function login(request: APIRequestContext, email: string, password: string, headers: Record<string, string> = {}) {
  return request.post('/api/auth/login', { data: { email, password }, headers })
}

test.beforeEach(async ({ request }) => { expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy() })

test('organizer recovery link is shown once, sets a new password and ends only that player’s sessions', async ({ browser, request, playwright }) => {
  // Two signed-in players before the reset.
  const player = await playwright.request.newContext({ baseURL: APP })
  const other = await playwright.request.newContext({ baseURL: APP })
  expect((await login(player, EMAIL, PASSWORD)).ok()).toBeTruthy()
  expect((await login(other, 'other@example.test', PASSWORD)).ok()).toBeTruthy()

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const [name, value] = (await adminCookie()).split('=')
  await adminContext.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
  const admin = await adminContext.newPage()
  await admin.goto('/admin/players')
  const row = admin.getByRole('row').filter({ hasText: 'player+test@example.test' })
  await row.getByText('Manage').click()
  admin.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: 'Reset Link' }).click()
  const dialog = admin.getByRole('dialog')
  await expect(dialog).toContainText('No email is sent')
  await expect(dialog).toContainText('expires in 60 minutes')
  const link = await dialog.getByLabel('One-time reset link').inputValue()
  expect(link).toMatch(new RegExp(`^${APP}/reset-password#token=[a-f0-9]{64}$`))
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(admin.getByRole('dialog')).toHaveCount(0)
  await adminContext.close()

  // The participant opens the link in their own browser.
  const participant = await browser.newPage()
  await participant.goto(link)
  await participant.getByLabel('New password', { exact: true }).fill('RecoveredPass456!')
  await participant.getByLabel('Confirm new password', { exact: true }).fill('RecoveredPass456!')
  await participant.getByRole('button', { name: 'Set new password' }).click()
  await expect(participant.getByText('Password updated. Log in with your new password.')).toBeVisible()
  expect(participant.url()).not.toContain('token')
  await participant.close()

  expect((await player.post('/api/notifications', { data: { enabled: false } })).status()).toBe(401)
  expect((await other.post('/api/notifications', { data: { enabled: false } })).status()).toBe(200)
  expect((await login(request, EMAIL, PASSWORD)).status()).toBe(401)
  expect((await login(request, EMAIL, 'RecoveredPass456!')).status()).toBe(200)
  expect((await login(request, 'other@example.test', PASSWORD)).status()).toBe(200)

  const token = new URL(link).hash.slice('#token='.length)
  const audit = await db(request, 'audit_log')
  const events = audit.filter((row: { player_id: string }) => row.player_id === PLAYER).map((row: { event_type: string }) => row.event_type)
  expect(events).toEqual(expect.arrayContaining(['password-reset-link-created', 'password-reset']))
  const serialized = JSON.stringify(audit)
  expect(serialized).not.toContain(token)
  expect(serialized).not.toContain(createHash('sha256').update(token).digest('hex'))
  expect((await db(request, 'notification_outbox')).filter((row: { kind: string }) => row.kind === 'password-reset')).toHaveLength(0)
  await player.dispose()
  await other.dispose()
})

test('organizer recovery links: a newer link kills the older one, and used, expired or unknown links are refused', async ({ request }) => {
  const first = await issueLink(request)
  const second = await issueLink(request)
  expect(first.expiresInMinutes).toBe(60)
  expect(Date.parse(second.expiresAt) - Date.now()).toBeGreaterThan(59 * 60 * 1000)
  expect((await consume(request, first.token, 'FirstLinkPass123!')).status()).toBe(400)
  expect((await login(request, EMAIL, PASSWORD)).status()).toBe(200)

  expect((await consume(request, second.token, 'SecondLinkPass123!')).status()).toBe(200)
  const reused = await consume(request, second.token, 'ReusedLinkPass123!')
  expect(reused.status()).toBe(400)
  expect((await reused.json()).error).toMatch(/already been used/)
  expect((await login(request, EMAIL, 'SecondLinkPass123!')).status()).toBe(200)
  expect((await login(request, EMAIL, 'ReusedLinkPass123!')).status()).toBe(401)

  const third = await issueLink(request)
  await request.patch(`${FIXTURE_DB}/players?id=eq.${PLAYER}`, { data: { pin_reset_expires: new Date(Date.now() - 1000).toISOString() } })
  const expired = await consume(request, third.token, 'ExpiredLinkPass123!')
  expect(expired.status()).toBe(400)
  expect((await expired.json()).error).toMatch(/expired/)

  const before = (await db(request, 'audit_log')).length
  expect((await consume(request, 'f'.repeat(64), 'UnknownLinkPass123!')).status()).toBe(400)
  expect((await consume(request, 'not-a-token', 'UnknownLinkPass123!')).status()).toBe(400)
  expect((await db(request, 'audit_log')).length).toBe(before)

  const audit = await db(request, 'audit_log')
  const events = audit.filter((row: { player_id: string }) => row.player_id === PLAYER).map((row: { event_type: string }) => row.event_type)
  expect(events.filter((event: string) => event === 'password-reset-link-created')).toHaveLength(3)
  expect(events).toEqual(expect.arrayContaining(['password-reset-link-reused', 'password-reset-link-expired', 'password-reset']))
  const serialized = JSON.stringify(audit)
  for (const link of [first, second, third]) {
    expect(serialized).not.toContain(link.token)
    expect(serialized).not.toContain(createHash('sha256').update(link.token).digest('hex'))
  }
  // The organizer's later screens never return a link again.
  const players = await (await request.get('/admin/players', { headers: { Cookie: await adminCookie() } })).text()
  expect(players).not.toContain(third.token)
})

test('only an organizer session can create a recovery link', async ({ request }) => {
  expect((await request.post(`/api/players/${PLAYER}/regen-pin`)).status()).toBe(401)
  expect((await login(request, EMAIL, PASSWORD)).ok()).toBeTruthy()
  expect((await request.post(`/api/players/${PLAYER}/regen-pin`)).status()).toBe(401)
  expect((await request.post(`/api/players/${OTHER}/regen-pin`)).status()).toBe(401)
  const missing = await request.post('/api/players/00000000-0000-4000-8000-0000000000ff/regen-pin', { headers: { Cookie: await adminCookie() } })
  expect(missing.status()).toBe(404)
  // No-email recovery page: same answer whatever the address.
  for (const email of [EMAIL, 'nobody@example.test']) {
    const answer = await request.post('/api/forgot-pin', { data: { email } })
    expect(answer.status()).toBe(410)
    expect((await answer.json()).error).toMatch(/Contact the pool organizer/)
  }
})

test('two simultaneous uses of one organizer recovery link: exactly one changes the password', async ({ request }) => {
  const { token } = await issueLink(request)
  const [a, b] = await Promise.all([consume(request, token, 'RaceWinnerA123!'), consume(request, token, 'RaceWinnerB123!')])
  expect([a.status(), b.status()].sort()).toEqual([200, 400])
  const winner = a.status() === 200 ? 'RaceWinnerA123!' : 'RaceWinnerB123!'
  const loser = winner === 'RaceWinnerA123!' ? 'RaceWinnerB123!' : 'RaceWinnerA123!'
  expect((await login(request, EMAIL, winner)).status()).toBe(200)
  expect((await login(request, EMAIL, loser)).status()).toBe(401)
})

test('shared network: 300 players behind one address sign in and save picks; guessing one account is throttled', async ({ request, playwright }) => {
  test.setTimeout(300000)
  const NAT = { 'x-real-ip': '203.0.113.77' }
  const hash = await bcrypt.hash('CampusPass123!', 4)
  const players = Array.from({ length: 300 }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, full_name: `Campus Player ${i}`, email: `campus${i}@example.test`, pin_hash: hash,
  }))
  expect((await request.post(`${FIXTURE_DB}/players`, { data: players })).ok()).toBeTruthy()
  const started = Date.now()
  const failures: string[] = []
  await Promise.all(Array.from({ length: 10 }, async (_, lane) => {
    const client = await playwright.request.newContext({ baseURL: APP, extraHTTPHeaders: NAT })
    for (let i = lane; i < players.length; i += 10) {
      const signedIn = await client.post('/api/auth/login', { data: { email: players[i].email, password: 'CampusPass123!' } })
      if (signedIn.status() !== 200) { failures.push(`login ${i}: ${signedIn.status()}`); continue }
      const pick = await client.post('/api/picks', { data: { slate_id: SLATE, team: i % 2 ? 'A' : 'B' } })
      if (pick.status() !== 200) failures.push(`pick ${i}: ${pick.status()}`)
    }
    await client.dispose()
  }))
  expect(failures).toEqual([])
  expect(Date.now() - started).toBeLessThan(5 * 60 * 1000)
  const picks = await db(request, 'picks?limit=1000')
  expect(picks.filter((pick: { player_id: string }) => pick.player_id.startsWith('10000000-')).length).toBe(300)

  const statuses = []
  for (let i = 0; i < 20; i++) statuses.push((await login(request, EMAIL, `WrongGuess${i}!`, NAT)).status())
  expect(statuses.filter(status => status === 401)).toHaveLength(10)
  expect(statuses.filter(status => status === 429)).toHaveLength(10)
  // The correct password is also held back on that address for this account...
  expect((await login(request, EMAIL, PASSWORD, NAT)).status()).toBe(429)
  // ...while everyone else on the same network still signs in.
  expect((await login(request, 'other@example.test', PASSWORD, NAT)).status()).toBe(200)
  expect((await login(request, 'campus7@example.test', 'CampusPass123!', NAT)).status()).toBe(200)
})
