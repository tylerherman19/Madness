import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getIP } from '@/lib/rateLimit'
import { serverError } from '@/lib/alerts'

export async function POST(req: NextRequest) {
  try {
    const ip = await getIP()
    const { allowed } = await checkRateLimit(`forgot-pin:${ip}`, 30, 60 * 60)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests from this device. Try again in an hour.' },
        { status: 429 }
      )
    }

    // Same answer for every address: no email is sent and nothing reveals
    // whether an account exists. The organizer issues one-time reset links.
    await req.json().catch(() => null)
    return NextResponse.json(
      { error: 'Contact the pool organizer. They can give you a one-time link to choose a new password.' },
      { status: 410 }
    )
  } catch (err) {
    return serverError('api/forgot-pin', err)
  }
}
