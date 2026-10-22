import 'server-only'
import {unsubscribeFooter,unsubscribeHeaders} from './unsubscribe'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const FROM_EMAIL = 'Griffin Sell - Madness <pool@pickandpray.org>'
export const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
export type EmailRequest = {
  from: string
  to: string
  subject: string
  html?: string
  text?: string
  headers?: Record<string,string>
}
export function sealRequest(request: EmailRequest): { sealed: string } {
  const key = Buffer.from(process.env.RECOVERY_EMAIL_KEY ?? '', 'base64')
  if (key.length !== 32)
    throw new Error('RECOVERY_EMAIL_KEY must be a 32-byte base64 key')
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(request), 'utf8'),
    cipher.final(),
  ])
  return {
    sealed: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    ),
  }
}
export function openRequest(
  value: EmailRequest | { sealed: string },
): EmailRequest {
  if (!('sealed' in value)) return value
  const key = Buffer.from(process.env.RECOVERY_EMAIL_KEY ?? '', 'base64'),
    bytes = Buffer.from(value.sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString(),
  )
}
export async function recordEmail(
  db: SupabaseClient,
  request: EmailRequest,
  kind = 'transactional',
  key = randomUUID(),
  expires = new Date(Date.now() + 86400000).toISOString(),
) {
  const { error } = await db
    .from('notification_outbox')
    .upsert(
      {
        event_key: key,
        kind,
        recipient: request.to,
        payload: { request },
        expires_at: expires,
        priority: kind === 'operational' ? 20 : 50,
      },
      { onConflict: 'event_key', ignoreDuplicates: true },
    )
  if (error) throw error
  return { ok: true, sent: false }
}
export type DeliveryEvent = {
  id: string
  kind: string
  payload: Record<string, unknown>
  recipient: string
  player_id: string | null
  lease_token: string
  attempts: number
  expires_at: string
  frozen_request: EmailRequest | { sealed: string } | null
}
export function renderNotification(
  event: DeliveryEvent,
): EmailRequest | { sealed: string } {
  if (event.payload.request)
    return event.payload.request as EmailRequest | { sealed: string }
  const p = event.payload
  const label =
    event.kind === 'reminder'
      ? 'Your pick deadline is approaching'
      : event.kind === 'elimination'
        ? 'Entry eliminated'
        : event.kind === 'announcement'
          ? String(p.subject)
          : 'Saved pick receipt'
  const message =
    event.kind === 'announcement'
      ? String(p.message)
      : event.kind === 'reminder'
        ? `Complete your required selections before ${p.deadline}.`
        : event.kind === 'elimination'
          ? 'Your entry is currently eliminated. Check Madness for results and corrections.'
          : `Saved ${p.team}, revision ${p.version}, accepted ${p.accepted_at}. This is a receipt for that revision. Check Madness for your current selection.`
  return {
    from: FROM_EMAIL,
    to: event.recipient,
    subject: `Madness: ${label}`,
    ...(event.player_id?{headers:unsubscribeHeaders(event.player_id)}:{}),
    html: `<p>Hi ${esc(String(p.name ?? ''))},</p><p>${esc(message).replace(/\n/g, '<br>')}</p><p><a href="${esc(process.env.NEXT_PUBLIC_APP_URL ?? 'https://madness-cyan.vercel.app')}">Open Madness</a></p>${event.player_id?unsubscribeFooter(event.player_id):''}`,
  }
}
