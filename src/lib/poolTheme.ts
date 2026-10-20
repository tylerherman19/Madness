import type { CSSProperties } from 'react'
import { normalizeRound, seedToShow, type CompetitionMode, type TournamentRound } from './competition'

// How the pool pages look and what they call things in each competition mode.
// The mode itself is the administrator's stored choice (see lib/pool.ts); this
// module only turns it into colors and labels. No database, no clock, so both
// server and client components import it.

export interface PoolTheme {
  head: string // header, scoreboard and other dark surfaces
  accent: string // actions and selection
  accent2: string // accents drawn on the dark head color
  tint: string
  ink: string
  mut: string
  line: string
  soft: string
}

export const POOL_THEMES: Record<CompetitionMode, PoolTheme> = {
  'march-madness': {
    head: '#0B2545', accent: '#1D6FE0', accent2: '#5AA2FF', tint: '#EAF2FE',
    ink: '#0B2545', mut: '#4A6283', line: '#D8DEE9', soft: '#EDF1F7',
  },
  'regular-season': {
    head: '#1E2227', accent: '#D9581A', accent2: '#FF9A5C', tint: '#FCEDE3',
    ink: '#1E2227', mut: '#5C6168', line: '#E0E0DD', soft: '#EFEFED',
  },
}

export function themeFor(mode: CompetitionMode | undefined): PoolTheme {
  return POOL_THEMES[mode ?? 'regular-season'] ?? POOL_THEMES['regular-season']
}

// The theme as CSS custom properties, set once on the page shell. The legacy
// tokens are remapped too, so older screens inside the shell pick up the mode.
export function themeStyle(mode: CompetitionMode | undefined): CSSProperties {
  const t = themeFor(mode)
  return {
    '--pp-head': t.head,
    '--pp-accent': t.accent,
    '--pp-accent2': t.accent2,
    '--pp-tint': t.tint,
    '--pp-ink': t.ink,
    '--pp-mut': t.mut,
    '--pp-line': t.line,
    '--pp-soft': t.soft,
    '--ink': t.ink,
    '--accent': t.accent,
    '--accent-strong': t.accent,
    '--accent-tint': t.tint,
    '--paper': '#F7F7F4',
  } as CSSProperties
}

// "NCAA Tournament 2027" or "2026–27 season". season_year is the year the
// season ends, the way ESPN numbers it.
export function eventLabel(mode: CompetitionMode | undefined, seasonYear?: number | null): string {
  if (mode === 'march-madness') return seasonYear ? `NCAA Tournament ${seasonYear}` : 'NCAA Tournament'
  return seasonYear ? `${seasonYear - 1}–${String(seasonYear).slice(-2)} season` : 'Regular season'
}

// What the number next to a team means.
export function teamTagName(mode: CompetitionMode | undefined): string {
  return mode === 'march-madness' ? 'seed' : 'AP rank'
}

const ROUND_TITLE: Record<TournamentRound, string> = {
  'First Four': 'First Four',
  '1st Round': 'Round of 64',
  '2nd Round': 'Round of 32',
  'Sweet 16': 'Sweet 16',
  'Elite 8': 'Elite Eight',
  'Final Four': 'Final Four',
  'National Championship': 'Championship',
}

const ROUND_SHORT: Record<TournamentRound, string> = {
  'First Four': 'FF',
  '1st Round': 'R64',
  '2nd Round': 'R32',
  'Sweet 16': 'S16',
  'Elite 8': 'E8',
  'Final Four': 'F4',
  'National Championship': 'Title',
}

export function roundTitle(round: string | null | undefined): string | null {
  const r = normalizeRound(round)
  return r ? ROUND_TITLE[r] : null
}

export function roundShort(round: string | null | undefined): string | null {
  const r = normalizeRound(round)
  return r ? ROUND_SHORT[r] : null
}

// slate_date is a bare YYYY-MM-DD; read it at noon so no timezone shift rolls
// it onto the next day.
function noon(date: string): Date {
  return new Date(`${String(date).slice(0, 10)}T12:00:00`)
}

// "Sun, Mar 21"
export function dayDate(date: string): string {
  return noon(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// "Sun 21"
export function weekdayDay(date: string): string {
  const d = noon(date)
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`
}

// "Fri"
export function weekdayShort(date: string): string {
  return noon(date).toLocaleDateString('en-US', { weekday: 'short' })
}

// "Thu Mar 18"
export function weekdayMonthDay(date: string): string {
  return dayDate(date).replace(',', '')
}

// The page title for a pick day: "Round of 32, Day 4" in the tournament,
// "Saturday slate, Day 9" in the regular season.
export function pickDayTitle(round: string | null | undefined, date: string, dayNumber: number): string {
  const title = roundTitle(round)
  if (title) return `${title}, Day ${dayNumber}`
  return `${noon(date).toLocaleDateString('en-US', { weekday: 'long' })} slate, Day ${dayNumber}`
}

const CT = 'America/Chicago'

// "11:10 AM", in the pool's own timezone.
export function tipTime(iso: string | null | undefined): string {
  if (!iso) return 'TBD'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'TBD'
  return d.toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' })
}

// The number shown next to a team: its bracket seed in the tournament, its AP
// poll position (top 25 only) the rest of the year. Both arrive in the same
// stored seed column.
export function teamTag(mode: CompetitionMode, seed: number | null | undefined, roundLabel: string | null | undefined): number | null {
  if (mode === 'march-madness') return seedToShow(mode, seed, roundLabel)
  if (normalizeRound(roundLabel)) return null
  return seed != null && seed >= 1 && seed <= 25 ? seed : null
}
