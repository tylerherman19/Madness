import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, readJsonObject, badRequest, serverError } from '@/lib/api'
import { getResend, esc, isDeliverable, FROM_EMAIL } from '@/lib/email'
import { logAudit } from '@/lib/audit'

// Sends are paced at ~1.6/sec for Resend rate limits, so allow up to 4 min of runtime
export const maxDuration = 300

const MAX_RECIPIENTS = 300
// Resend free tier allows ~2 requests/sec — pace sends to stay under it
const SEND_DELAY_MS = 600

const VALID_AUDIENCES = ['all', 'alive', 'unpicked'] as const
type Audience = (typeof VALID_AUDIENCES)[number]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await readJsonObject(req)
    if (!body) return badRequest()
    const { subject, message, audience } = body

    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return NextResponse.json({ error: 'Missing subject' }, { status: 400 })
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Missing message' }, { status: 400 })
    }
    if (subject.length > 200 || message.length > 10_000) {
      return badRequest('Subject must be under 200 characters and the message under 10,000')
    }
    if (!VALID_AUDIENCES.includes(audience as Audience)) {
      return NextResponse.json({ error: 'Invalid audience. Use all, alive, or unpicked' }, { status: 400 })
    }

    const supabase = await getDb()
    const { data: allPlayers, error } = await supabase
      .from('players')
      .select('id, full_name, email, status')
    if (error) return serverError('broadcast player load error', error, 'Could not load players')

    // Internal test accounts have fake emails that would bounce
    let recipients = (allPlayers || []).filter((p) => p.email && isDeliverable(p.email))

    if (audience === 'alive') {
      recipients = recipients.filter((p) => p.status === 'alive')
    } else if (audience === 'unpicked') {
      const { data: slate } = await supabase.from('slates').select('id').eq('is_active', true).maybeSingle()
      if (!slate) return NextResponse.json({ error: 'No active slate — cannot compute unpicked players' }, { status: 400 })
      const { data: picks, error: picksError } = await supabase.from('picks').select('player_id').eq('slate_id', slate.id)
      // Without the pick list every alive player would look "unpicked".
      if (picksError) return serverError('broadcast picks load error', picksError, 'Could not load picks')
      const pickedIds = new Set((picks || []).map((p) => p.player_id))
      recipients = recipients.filter((p) => p.status === 'alive' && !pickedIds.has(p.id))
    }

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients match that audience' }, { status: 400 })
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: `Audience too large (${recipients.length} > ${MAX_RECIPIENTS})` }, { status: 400 })
    }

    const resend = getResend()
    const htmlBody = esc(message.trim()).replace(/\r?\n/g, '<br />')

    let sent = 0
    const failures: string[] = []
    for (const player of recipients) {
      // Resend reports failures via `error`, it does not throw — check it,
      // or the send report would claim success for every recipient.
      const { error: sendError } = await resend.emails.send({
        from: FROM_EMAIL,
        to: player.email,
        subject: subject.trim(),
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <p>Hey ${esc(player.full_name)},</p>
            <p>${htmlBody}</p>
            <p style="margin-top: 24px; color: #666; font-size: 14px;">— Madness Survivor Pool</p>
          </div>
        `,
      })
      if (sendError) {
        // Log the player id, not the address — runtime logs are not a place for PII.
        console.error(`Broadcast to player ${player.id} failed:`, sendError)
        failures.push(player.full_name)
      } else {
        sent++
      }
      if (recipients.length > 2) await sleep(SEND_DELAY_MS)
    }

    await logAudit(supabase, {
      event_type: 'broadcast-sent',
      actor: 'admin',
      message: `Admin emailed ${sent} of ${recipients.length} (${audience}): "${subject.trim()}"${failures.length > 0 ? ` — ${failures.length} failed` : ''}`,
      details: { subject: subject.trim(), audience, sent, total: recipients.length, failures },
    })

    return NextResponse.json({
      ok: true,
      sent,
      total: recipients.length,
      failures: failures.length > 0 ? failures : undefined,
    })
  } catch (err) {
    console.error('broadcast error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
