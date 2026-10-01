import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, isUuid } from '@/lib/api'
import { gradeStoredSlate, settleIfDecided } from '@/lib/settle'

// Grading awaits an elimination email per eliminated player.
export const maxDuration = 300

// Admin "Grade All Picks": grade one day from the results already stored for
// it. Pulling fresh results from ESPN is the results job's work (the admin
// Results page has a button for that too).
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

    const { games, grading } = await gradeStoredSlate(supabase, slate)
    if (!grading) {
      return NextResponse.json({ error: 'No completed games found for this slate' }, { status: 400 })
    }
    const settled = await settleIfDecided(supabase, slate.id, games, grading)

    return NextResponse.json({ ok: true, grading, settled })
  } catch (err) {
    console.error('grade-slate error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
