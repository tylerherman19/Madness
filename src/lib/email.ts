import { Resend } from 'resend'
import { createHash } from 'node:crypto'
import { reportFailure } from './alerts'
import { supabase } from './supabase'
import { unsubscribeFooter, unsubscribeHeaders } from './unsubscribe'

let _resend: Resend | null = null

// This pool sends no email. Every send in the app funnels through getResend()
// — including the admin broadcast route, which bypasses sendChecked — so the
// kill switch lives here rather than in sendChecked. Sending requires
// EMAILS_ENABLED to be exactly 'true'; a missing or malformed var means no
// email goes out, so a forgotten Vercel variable fails safe.

function suppressedClient(): Resend {
  return {
    emails: {
      async send() {
        return { data: null, error: null }
      },
    },
  } as unknown as Resend
}

export function getResend(): Resend {
  // Not cached: flipping EMAILS_ENABLED takes effect without a cold start.
  if (process.env.EMAILS_ENABLED !== 'true') return suppressedClient()
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

export const FROM_EMAIL = 'Griffin Sell - Madness <pool@pickandpray.org>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://madness-cyan.vercel.app'

// Resend's free tier allows ~2 requests/sec — loops sending to many
// recipients must pace themselves with this delay between sends.
export const SEND_DELAY_MS = 600

export function sleep(ms: number): Promise<void> {
  if (process.env.EMAILS_ENABLED !== 'true') return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The Resend SDK reports failures via its `{ error }` return value — it does
// NOT throw — so every sender below checks it and reports back. Callers must
// look at `ok` (and count failures) instead of assuming a resolved promise
// means the email was delivered.
export interface SendResult {
  ok: boolean
  error?: string
}

// Reset delivery has its own switch while account email is being configured.
// Both switches must be enabled before a reset link can leave the app.
export async function sendPasswordResetEmail(
  email: string,
  fullName: string,
  token: string
): Promise<{ ok: boolean; sent: boolean }> {
  if (process.env.EMAILS_ENABLED !== 'true' || process.env.PASSWORD_RESET_EMAILS_ENABLED !== 'true') {
    return { ok: true, sent: false }
  }
  if (!isDeliverable(email)) return { ok: true, sent: false }

  const resetUrl = new URL('/reset-password', APP_URL)
  resetUrl.searchParams.set('token', token)
  const result = await sendChecked({
    to: email,
    subject: 'Reset your Madness password',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        ${LOGO_HEADER}
        <p>Hi ${esc(fullName)},</p>
        <p>A password reset was requested for your Madness account. This link expires in one hour.</p>
        <a href="${esc(resetUrl.toString())}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Choose a new password</a>
        <p>If you did not request this, you can ignore this email. Your password has not changed.</p>
      </div>
    `,
  })
  return { ok: result.ok, sent: result.ok }
}

const LOGO_HEADER = `
  <table role="presentation" align="center" style="margin: 0 auto 20px;" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding-right: 12px;"><img src="${APP_URL}/logo.png" width="64" height="64" alt="Pick and Pray" style="border-radius: 50%; display: block;" /></td>
      <td style="font-family: Arial, Helvetica, sans-serif; font-weight: 900; font-size: 22px; letter-spacing: 1px; color: #1a1a1a; white-space: nowrap;">MADNESS</td>
    </tr>
  </table>
`

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Internal/test accounts (including sandbox test users) carry fake addresses
// that would bounce — never hand them to Resend.
export function isDeliverable(email: string): boolean {
  return !email.endsWith('@nflsurvivor.internal')
}

async function sendChecked(payload: {
  to: string
  subject: string
  html: string
  headers?: Record<string, string>
}): Promise<SendResult> {
  const { error } = await getResend().emails.send({ from: FROM_EMAIL, ...payload })
  if (error) {
    console.error('Transactional email rejected by provider')
    // Senders have no request-scoped client; sandbox test users carry
    // undeliverable addresses and never get this far, so this is production.
    await reportFailure(supabase, {
      kind: 'email-failed',
      source: 'email',
      key: `email:${createHash('sha256').update(payload.to.toLowerCase()).digest('hex')}:${payload.subject}`,
      message: `Transactional email failed: "${payload.subject}"`,
      error,
    })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function sendPickConfirmationEmail(
  playerId: string,
  email: string,
  fullName: string,
  teamAbbr: string,
  slateNumber: number
): Promise<SendResult> {
  if (!isDeliverable(email)) return { ok: true }
  const teamName = teamAbbr
  return sendChecked({
    to: email,
    subject: `You're Rolling With ${teamName} — Slate ${slateNumber}`,
    headers: unsubscribeHeaders(playerId),
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        ${LOGO_HEADER}
        <p>Hey ${esc(fullName)},</p>
        <p>You&rsquo;re locked in with ${esc(teamName)} for Slate ${slateNumber}. You can still change it until the first game of the day tips off; changes must reach the server before that deadline. Let&rsquo;s see how it shakes out.</p>
        <a href="${APP_URL}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Standings</a>
        <p style="margin-top: 24px;">Best of luck,</p>
        <p>Griffin Sell</p>
        ${unsubscribeFooter(playerId)}
      </div>
    `,
  })
}
