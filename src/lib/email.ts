import { Resend } from 'resend'

let _resend: Resend | null = null

// This pool sends no email. Every send in the app funnels through getResend()
// — including the admin broadcast route, which bypasses sendChecked — so the
// kill switch lives here rather than in sendChecked. Sending requires
// EMAILS_ENABLED to be exactly 'true'; a missing or malformed var means no
// email goes out, so a forgotten Vercel variable fails safe.
type SendPayload = { to: string | string[]; subject: string; [key: string]: unknown }

function suppressedClient(): Resend {
  return {
    emails: {
      async send(payload: SendPayload) {
        console.log(
          `[email suppressed] to=${payload.to} subject="${payload.subject}"`
        )
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

export const FROM_EMAIL = 'Griffin Sell - NFL Survivor <pool@pickandpray.org>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pickandpray.org'

// Resend's free tier allows ~2 requests/sec — loops sending to many
// recipients must pace themselves with this delay between sends.
export const SEND_DELAY_MS = 600

export function sleep(ms: number): Promise<void> {
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
}): Promise<SendResult> {
  const { error } = await getResend().emails.send({ from: FROM_EMAIL, ...payload })
  if (error) {
    console.error(`Email to ${payload.to} failed ("${payload.subject}"):`, error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function sendPickConfirmationEmail(
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
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        ${LOGO_HEADER}
        <p>Hey ${esc(fullName)},</p>
        <p>You&rsquo;re locked in with ${esc(teamName)} for Slate ${slateNumber}. You can still change it up until kickoff or Sunday at 12PM CT, whichever comes first. Let&rsquo;s see how it shakes out.</p>
        <a href="${APP_URL}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Standings</a>
        <p style="margin-top: 24px;">Best of luck,</p>
        <p>Griffin Sell</p>
      </div>
    `,
  })
}

// `teamAbbr` is null for a missed-deadline elimination (no team was picked).
export async function sendEliminationEmail(
  email: string,
  fullName: string,
  teamAbbr: string | null,
  slateNumber: number
): Promise<SendResult> {
  if (!isDeliverable(email)) return { ok: true }
  const teamName = teamAbbr
  const outcome = teamName
    ? `Well&hellip; ${esc(teamName)} came up short.`
    : `Well&hellip; you missed the deadline.`
  return sendChecked({
    to: email,
    subject: `Tough One — You're Out Slate ${slateNumber}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        ${LOGO_HEADER}
        <p>Hey ${esc(fullName)},</p>
        <p>${outcome} You&rsquo;ve been eliminated from the pool. Feel free to stick around, follow the standings, and enjoy watching until a winner is crowned.</p>
        <p>Thanks for playing this year. Will be running it back for March Madness, so stay tuned!</p>
        <a href="${APP_URL}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Standings</a>
        <p style="margin-top: 24px;">All the best,</p>
        <p>Griffin Sell</p>
      </div>
    `,
  })
}

export async function sendReminderEmail(
  email: string,
  fullName: string,
  slateNumber: number,
  deadlineStr: string
): Promise<SendResult> {
  if (!isDeliverable(email)) return { ok: true }
  return sendChecked({
    to: email,
    subject: `Don't Sleep On This — Slate ${slateNumber} Pick Due Soon`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        ${LOGO_HEADER}
        <p>Hey ${esc(fullName)},</p>
        <p>Still waiting on your pick...</p>
        <p>Deadline: ${esc(deadlineStr)}</p>
        <p>Get your pick in before then or you&rsquo;ll get auto-picked. Take two minutes and lock it in.</p>
        <a href="${APP_URL}/pick" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Submit My Pick</a>
        <p style="margin-top: 24px;">Good luck,</p>
        <p>Griffin Sell</p>
      </div>
    `,
  })
}
