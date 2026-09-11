import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import RecapClient from './RecapClient'

export default async function RecapPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const { data: activeSlate } = await supabase
    .from('slates')
    .select('*')
    .eq('is_active', true)
    .single()

  let recapText = ''

  if (activeSlate) {
    const [{ data: games }, { data: players }, { data: picks }] = await Promise.all([
      supabase.from('games').select('*').eq('slate_id', activeSlate.id).order('tip_time'),
      supabase.from('players').select('*'),
      supabase.from('picks').select('*, players(full_name)').eq('slate_id', activeSlate.id),
    ])

    const { generateRecap } = await import('@/lib/recap')
    const { slateDeadline } = await import('@/lib/deadline')

    const allPlayers = (players || []).filter(
      (p: { email: string }) => !p.email?.endsWith('@nflsurvivor.internal')
    )
    const alivePlayers = allPlayers.filter((p: { status: string }) => p.status === 'alive')
    const eliminatedThisWeek = allPlayers.filter(
      (p: { elimination_slate: number | null }) => p.elimination_slate === activeSlate.slate_number
    )

    const totalPaid = allPlayers.filter((p: { paid: boolean }) => p.paid).length
    const potSize = totalPaid * 25

    const slateLockTime = games ? slateDeadline(activeSlate, games) : null

    recapText = generateRecap({
      slate: activeSlate,
      games: games || [],
      picks: (picks || []) as Parameters<typeof generateRecap>[0]['picks'],
      players: allPlayers,
      alivePlayers,
      eliminatedThisWeek,
      potSize,
      nextDeadline: slateLockTime?.toISOString() || null,
    })
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">📋 Weekly Recap</h1>
      {!activeSlate ? (
        <p className="text-slate-400">No active slate.</p>
      ) : (
        <RecapClient slateNumber={activeSlate.slate_number} recapText={recapText} />
      )}
    </div>
  )
}
