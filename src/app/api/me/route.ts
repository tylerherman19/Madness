import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getContestCore } from '@/lib/dashboard'
import { loadMyPicks } from '@/lib/myEntry'
import { slateDeadline } from '@/lib/deadline'
import { pickStateOf, type Viewer } from '@/lib/viewerState'
import { haveSignupsClosedCached } from '@/lib/season'

// The signed-in visitor, for the header on pages that are built ahead and
// shared (schedule, grid, legal pages): they can't read the session
// themselves. Per visitor, so never cached anywhere.
export const dynamic = 'force-dynamic'

const PRIVATE = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const [session, signupsClosed] = await Promise.all([getSession(), haveSignupsClosedCached()])
  if (!session) return NextResponse.json({ name: null, signupsClosed } satisfies Viewer, { headers: PRIVATE })
  const [core, picks] = await Promise.all([getContestCore(), loadMyPicks(session.player_id)])
  const slate = core?.slate ?? null
  const me = core?.players.find((player) => player.id === session.player_id)
  const lock = slate && core ? slateDeadline(slate, core.slateGames) : null
  const viewer: Viewer = {
    name: session.full_name,
    signupsClosed,
    pick: core
      ? pickStateOf({
          hasSlate: !!slate,
          eliminated: me?.status === 'eliminated',
          locked: lock ? lock <= core.now : false,
          hasPick: !!slate && picks.some((pick) => pick.slateId === slate.id),
        })
      : undefined,
  }
  return NextResponse.json(viewer, { headers: PRIVATE })
}
