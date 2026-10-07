import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api'
import { isTestMode } from '@/lib/testMode'

export async function POST() {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized
  if (await isTestMode()) return NextResponse.json({ error: 'Production reset is unavailable from test mode.' }, { status: 403 })
  return NextResponse.json({ error: 'Live reset is disabled. Archive the competition and verify a backup before an operator performs a transactional reset.' }, { status: 409 })
}
