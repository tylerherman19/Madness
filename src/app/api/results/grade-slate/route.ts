import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { gradeSlatePicks } from '@/lib/grading'
import type { Game } from '@/types'

// Grading awaits a paced elimination email per eliminated player.
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { slate_id } = await req.json()
    if (!isUuid(slate_id)) return NextResponse.json({ error: 'Invalid slate_id' }, { status: 400 })

    const supabase = await getDb()

    const { data: slate } = await supabase
      .from('slates')
      .select('id, slate_number')
      .eq('id', slate_id)
      .single()
    if (!slate) return NextResponse.json({ error: 'Slate not found' }, { status: 404 })

    const { data: games } = await supabase
      .from('games')
      .select('*')
      .eq('slate_id', slate_id)
      .neq('result', 'pending')

    if (!games || games.length === 0) {
      return NextResponse.json({ error: 'No completed games found for this slate' }, { status: 400 })
    }

    const grading = await gradeSlatePicks(supabase, slate.id, slate.slate_number, games as Game[])

    return NextResponse.json({ ok: true, grading })
  } catch (err) {
    console.error('grade-slate error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
