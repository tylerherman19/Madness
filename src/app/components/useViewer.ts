'use client'

import { useEffect, useSyncExternalStore } from 'react'
import type { Viewer } from '@/lib/viewerState'

// One copy of "who is signed in" for the whole tab. Pages that read the
// session hand it over (seedViewer); pages built ahead for everyone ask
// /api/me once. Kept in memory, so moving between pages in the app reuses
// it; logging in or out clears it (resetViewer).
let current: Viewer | undefined
let fetchedAt = 0
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
const STALE_MS = 60_000

function emit() { listeners.forEach((listener) => listener()) }

function load() {
  if (inflight) return
  inflight = fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : { name: null }))
    .catch(() => current ?? { name: null })
    .then((viewer: Viewer) => {
      current = viewer
      fetchedAt = Date.now()
      emit()
    })
    .finally(() => { inflight = null })
}

export function seedViewer(viewer: Viewer) {
  if (current && current.name === viewer.name && current.pick === viewer.pick && (viewer.signupsClosed === undefined || current.signupsClosed === viewer.signupsClosed)) {
    fetchedAt = Date.now()
    return
  }
  // A page that knows the name but not the pick keeps a known pick for the
  // same person.
  current = {
    name: viewer.name,
    pick: viewer.pick ?? (current?.name === viewer.name ? current.pick : undefined),
    signupsClosed: viewer.signupsClosed ?? current?.signupsClosed,
  }
  fetchedAt = Date.now()
  emit()
}

export function resetViewer() {
  current = undefined
  fetchedAt = 0
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// `known` is what the page itself read: used at once, and kept for later
// pages. Without it the header shows the copy in memory, fetching one when
// there is none or it is a minute old. Undefined while unknown.
export function useViewer(known?: Viewer): Viewer | undefined {
  const stored = useSyncExternalStore(subscribe, () => current, () => undefined)
  const knownName = known?.name
  const knownPick = known?.pick
  const knownClosed = known?.signupsClosed
  const isKnown = known !== undefined
  useEffect(() => {
    if (isKnown) {
      seedViewer({ name: knownName ?? null, pick: knownPick, signupsClosed: knownClosed })
      // A signed-in page that didn't work out the pick state still needs it.
      if (knownName && !knownPick && !current?.pick) load()
      return
    }
    if (!current || Date.now() - fetchedAt > STALE_MS) load()
  }, [isKnown, knownName, knownPick, knownClosed])
  if (!isKnown) return stored
  return {
    name: known.name,
    pick: known.pick ?? (stored?.name === known.name ? stored.pick : undefined),
    signupsClosed: known.signupsClosed ?? stored?.signupsClosed,
  }
}
