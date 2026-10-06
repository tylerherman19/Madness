import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api'
import { sendAlertText } from '@/lib/alerts'

// Audit page "Send test text": confirms the email-to-SMS gateway delivers,
// and says exactly why not when email isn't switched on yet.
export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  const delivery = await sendAlertText('Madness test alert: failure texts are working.')
  return NextResponse.json(delivery)
}
