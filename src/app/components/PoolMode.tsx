'use client'

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CompetitionMode } from '@/lib/competition'

// The pool's mode for client pages that can't read the database themselves,
// such as the sign-in screens. Set by PoolThemeScope.
const PoolModeContext = createContext<{ mode?: CompetitionMode; seasonYear?: number | null }>({})

export function PoolModeProvider({ mode, seasonYear, children }: { mode: CompetitionMode; seasonYear: number | null; children: React.ReactNode }) {
  return <PoolModeContext.Provider value={{ mode, seasonYear }}>{children}</PoolModeContext.Provider>
}

export function usePoolMode() {
  return useContext(PoolModeContext)
}

// The last mode a page rendered with. Loading screens show before the next
// page's data arrives, so they borrow it to avoid flashing the wrong colors.
// Kept in memory for in-app navigation and in a cookie across visits.
const COOKIE = 'pp_mode'
let remembered: string | undefined // "march-madness|2027"
const listeners = new Set<() => void>()

export function rememberMode(mode: CompetitionMode, seasonYear?: number | null) {
  const value = `${mode}|${seasonYear ?? ''}`
  if (remembered === value) return
  remembered = value
  try {
    document.cookie = `${COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
  } catch { /* cookies blocked: memory still covers in-app navigation */ }
  listeners.forEach((listener) => listener())
}

function readRaw(): string | undefined {
  if (remembered) return remembered
  const value = document.cookie.match(/(?:^|; )pp_mode=([^;]+)/)?.[1]
  return value ? decodeURIComponent(value) : undefined
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useRememberedMode(): { mode?: CompetitionMode; seasonYear?: number } {
  const raw = useSyncExternalStore(subscribe, readRaw, () => undefined)
  const [mode, year] = (raw ?? '').split('|')
  if (mode !== 'march-madness' && mode !== 'regular-season') return {}
  return { mode, seasonYear: Number(year) || undefined }
}

// The signed-in name from the last real page, kept in memory only, so a
// loading screen in between keeps the same header.
let rememberedAccount: string | undefined
export function rememberAccount(account: string | undefined) {
  rememberedAccount = account
}
export function lastAccount(): string | undefined {
  return rememberedAccount
}
