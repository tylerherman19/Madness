// Operational alerts (failure texts and the daily summary) go straight to the
// email provider, separately from the player outbox. Player mail stays behind
// EMAILS_ENABLED, OUTBOX_DELIVERY_ENABLED and the admin delivery mode. Alerts
// must not wait for those switches: an alert that is only stored in the
// database cannot tell anyone the system is down.
//
// Who receives them: only the operator addresses in ALERT_SMS_TO. The lane is
// on in Vercel Production by default, off everywhere else (previews, local
// development, CI) unless OPERATIONAL_ALERTS_ENABLED=true is set. Setting
// OPERATIONAL_ALERTS_ENABLED=false turns it off in production too.

export type AlertEnv = Partial<Record<
  'ALERT_SMS_TO' | 'RESEND_API_KEY' | 'OPERATIONAL_ALERTS_ENABLED' | 'VERCEL_ENV',
  string
>>

export type AlertLane =
  | { direct: true; recipients: string[]; apiKey: string }
  | { direct: false; recipients: string[]; reason: string }

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

export function alertRecipients(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((s) => s.trim()).filter((s) => EMAIL.test(s)))]
}

export function alertLane(env: AlertEnv): AlertLane {
  const recipients = alertRecipients(env.ALERT_SMS_TO)
  if (!recipients.length) return { direct: false, recipients, reason: 'ALERT_SMS_TO is not configured' }
  if (env.OPERATIONAL_ALERTS_ENABLED === 'false') {
    return { direct: false, recipients, reason: 'Operational alerts are switched off (OPERATIONAL_ALERTS_ENABLED=false)' }
  }
  const enabled = env.OPERATIONAL_ALERTS_ENABLED === 'true' || env.VERCEL_ENV === 'production'
  if (!enabled) return { direct: false, recipients, reason: 'Operational alerts send only in production unless OPERATIONAL_ALERTS_ENABLED=true' }
  if (!env.RESEND_API_KEY) return { direct: false, recipients, reason: 'RESEND_API_KEY is not configured' }
  return { direct: true, recipients, apiKey: env.RESEND_API_KEY }
}

export type AlertSendOutcome = { recipient: string; ok: boolean; status?: number; providerId?: string }

// One request per recipient. The idempotency key makes a retried request for
// the same alert a no-op at the provider; nothing is retried here, because
// the caller's 30-minute text window already decides how often we try.
export async function sendAlertsDirect(
  lane: Extract<AlertLane, { direct: true }>,
  message: { from: string; subject: string; text: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AlertSendOutcome[]> {
  const outcomes: AlertSendOutcome[] = []
  for (const recipient of lane.recipients) {
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lane.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `madness-alert/${message.key}/${recipient}`,
        },
        body: JSON.stringify({ from: message.from, to: recipient, subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(8000),
      })
      const body = (await response.json().catch(() => ({}))) as { id?: unknown }
      outcomes.push({
        recipient,
        ok: response.ok && typeof body.id === 'string',
        status: response.status,
        ...(typeof body.id === 'string' ? { providerId: body.id } : {}),
      })
    } catch {
      outcomes.push({ recipient, ok: false })
    }
  }
  return outcomes
}
