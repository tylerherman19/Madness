'use client'

import { createContext, useContext } from 'react'
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
