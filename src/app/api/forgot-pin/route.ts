import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getIP } from '@/lib/rateLimit'

export async function POST(req: NextRequest) {
  try {
    const ip = await getIP()
    const { allowed } = await checkRateLimit(`forgot-pin:${ip}`, 5, 60 * 60)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests from this device. Try again in an hour.' },
        { status: 429 }
      )
    }

    await req.json().catch(() => null)
    return NextResponse.json(
      { error: 'Ask the pool organizer to set a temporary password for your entry.' },
      { status: 410 }
    )
  } catch (err) {
    console.error('forgot-pin error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
