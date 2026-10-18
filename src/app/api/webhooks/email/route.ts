import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { supabase } from '@/lib/supabase'
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
  const raw = await req.text()
  if (raw.length > 100_000) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  let event
  try {
    event = new Resend(process.env.RESEND_API_KEY).webhooks.verify({ payload: raw, headers: {
      id: req.headers.get('svix-id') ?? '', timestamp: req.headers.get('svix-timestamp') ?? '', signature: req.headers.get('svix-signature') ?? '',
    }, webhookSecret: secret })
  } catch { return NextResponse.json({ error: 'Invalid signature' }, { status: 401 }) }
  if (['email.bounced', 'email.complained'].includes(event.type)) {
    const data = event.data as { to?: string[] }
    if (!Array.isArray(data.to) || data.to.some(email => typeof email !== 'string' || email.length > 254)) return NextResponse.json({ error: 'Invalid recipient data' }, { status: 400 })
    for (const email of data.to ?? []) {
      const { error } = await supabase.from('email_suppressions').upsert({ email: email.trim().toLowerCase(), reason: event.type })
      if (error) return NextResponse.json({ error: 'Could not persist suppression' }, { status: 503 })
    }
  }
  return NextResponse.json({ ok: true })
}
