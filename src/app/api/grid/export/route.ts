import writeExcelFile, { type Cell, type SheetData } from 'write-excel-file/node'
import { buildPickPeriods } from '@/lib/competition'
import { isPickRevealed } from '@/lib/deadline'
import { getPoolConfig } from '@/lib/pool'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import type { Game } from '@/types'

export const dynamic = 'force-dynamic'

type ExportSlate = {
  id: string
  slate_number: number
  slate_date: string
  season_year: number
  is_active: boolean
  locks_at: string | null
}

type ExportPlayer = {
  id: string
  full_name: string
  status: string
  elimination_slate: number | null
}

type ExportPick = {
  player_id: string
  slate_id: string
  team: string
}

type ExportGame = Pick<Game, 'slate_id' | 'home_team' | 'away_team' | 'result' | 'tip_time' | 'round_label' | 'time_tbd'>

const headerCell = (value: string, align: 'left' | 'center' = 'center'): Cell => ({
  value,
  fontWeight: 'bold',
  textColor: '#FFFFFF',
  backgroundColor: '#0D1C34',
  borderColor: '#DDE5EF',
  borderStyle: 'thin',
  align,
  alignVertical: 'center',
  height: 28,
})

export async function GET() {
  try {
    const supabase = await getDb()
    const [slatesRes, playersRes, picksRes, gamesRes, pool] = await Promise.all([
      supabase.from('slates').select('id, slate_number, slate_date, season_year, is_active, locks_at').order('slate_number'),
      supabase
        .from('players')
        .select('id, full_name, status, elimination_slate')
        .not('email', 'like', '%@nflsurvivor.internal')
        .order('full_name'),
      supabase.from('picks').select('player_id, slate_id, team'),
      supabase.from('games').select('slate_id, home_team, away_team, result, tip_time, round_label, time_tbd'),
      getPoolConfig(supabase),
    ])

    const queryError = slatesRes.error || playersRes.error || picksRes.error || gamesRes.error
    if (queryError) throw queryError

    const allSlates = (slatesRes.data ?? []) as ExportSlate[]
    const players = (playersRes.data ?? []) as ExportPlayer[]
    const allPicks = (picksRes.data ?? []) as ExportPick[]
    const allGames = (gamesRes.data ?? []) as ExportGame[]
    const activeSlate = allSlates.find((slate) => slate.is_active && slate.season_year === pool.season_year)
    const seasonSlates = allSlates
      .filter((slate) => slate.season_year === pool.season_year)
      .sort((a, b) => a.slate_number - b.slate_number)

    const realPlayerIds = new Set(players.map((player) => player.id))
    const seasonSlateIds = new Set(seasonSlates.map((slate) => slate.id))
    const seasonPicks = allPicks.filter(
      (pick) => seasonSlateIds.has(pick.slate_id) && realPlayerIds.has(pick.player_id)
    )
    const pickedSlateIds = new Set(seasonPicks.map((pick) => pick.slate_id))
    const lastPickedSlate = seasonSlates.reduce(
      (max, slate) => pickedSlateIds.has(slate.id) ? Math.max(max, slate.slate_number) : max,
      0
    )
    const finalSlateNumber = activeSlate?.slate_number ?? lastPickedSlate
    const includedSlates = seasonSlates.filter((slate) => slate.slate_number <= finalSlateNumber)
    const includedSlateIds = new Set(includedSlates.map((slate) => slate.id))
    const includedPicks = seasonPicks.filter((pick) => includedSlateIds.has(pick.slate_id))

    const periods = buildPickPeriods(
      pool.competition_mode,
      includedSlates.map((slate) => ({
        id: slate.id,
        slate_number: slate.slate_number,
        slate_date: slate.slate_date,
        locks_at: slate.locks_at,
      })),
      allGames.map((game) => ({ slate_id: game.slate_id, round_label: game.round_label }))
    )
    const periodById = new Map(periods.map((period) => [period.id, period]))
    const pickMap = new Map<string, string[]>()
    for (const pick of includedPicks) {
      const key = `${pick.player_id}:${pick.slate_id}`
      pickMap.set(key, [...(pickMap.get(key) ?? []), pick.team])
    }
    const pickCountByPlayer = new Map<string, number>()
    for (const pick of includedPicks) {
      pickCountByPlayer.set(pick.player_id, (pickCountByPlayer.get(pick.player_id) ?? 0) + 1)
    }

    const sortedPlayers = players.slice().sort((a, b) => {
      if (a.status !== b.status) return a.status === 'alive' ? -1 : 1
      if (a.status === 'alive') {
        const countDifference = (pickCountByPlayer.get(b.id) ?? 0) - (pickCountByPlayer.get(a.id) ?? 0)
        if (countDifference !== 0) return countDifference
      } else {
        const eliminationDifference = (b.elimination_slate ?? 0) - (a.elimination_slate ?? 0)
        if (eliminationDifference !== 0) return eliminationDifference
      }
      return a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
    })

    const gamesBySlate = new Map<string, Game[]>()
    for (const game of allGames) {
      const games = gamesBySlate.get(game.slate_id) ?? []
      games.push(game as Game)
      gamesBySlate.set(game.slate_id, games)
    }
    const now = await getEffectiveNow()

    const sheetData: SheetData = [
      [
        headerCell('Player', 'left'),
        ...includedSlates.map((slate) => headerCell(periodById.get(slate.id)?.shortLabel ?? `#${slate.slate_number}`)),
      ],
      ...sortedPlayers.map((player) => [
        {
          value: player.full_name,
          fontWeight: 'bold' as const,
          borderColor: '#DDE5EF',
          bottomBorderStyle: 'thin' as const,
          alignVertical: 'center' as const,
          height: 22,
        },
        ...includedSlates.map((slate): Cell => {
          const teams = pickMap.get(`${player.id}:${slate.id}`) ?? []
          const value = !teams.length
            ? ''
            : isPickRevealed(slate, gamesBySlate.get(slate.id) ?? [], now)
              ? teams.join(' / ')
              : 'Hidden'
          return {
            value,
            align: 'center',
            alignVertical: 'center',
            borderColor: '#DDE5EF',
            bottomBorderStyle: 'thin',
          }
        }),
      ]),
    ]

    const workbook = await writeExcelFile(
      sheetData,
      {
        sheet: 'Pick Grid',
        columns: [{ width: 28 }, ...includedSlates.map(() => ({ width: 14 }))],
        stickyRowsCount: 1,
        stickyColumnsCount: 1,
        showGridLines: false,
        zoomScale: 1,
      },
      { fontFamily: 'Arial', fontSize: 11 }
    ).toBuffer()

    const modeLabel = pool.competition_mode === 'march-madness' ? 'march-madness' : 'regular-season'
    const through = finalSlateNumber > 0 ? `-through-${periodById.get(includedSlates.at(-1)?.id ?? '')?.shortLabel ?? `slate-${finalSlateNumber}`}` : ''
    const safeThrough = through.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    return new Response(new Uint8Array(workbook), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="madness-${pool.season_year}-${modeLabel}${safeThrough}.xlsx"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    console.error('Pick grid Excel export failed:', error)
    return Response.json({ error: 'Unable to export the pick grid.' }, { status: 500 })
  }
}
