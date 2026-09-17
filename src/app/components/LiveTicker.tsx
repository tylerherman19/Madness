'use client'
/* eslint-disable @next/next/no-img-element -- ESPN supplies tiny 20px scoreboard marks; the optimizer adds no value here. */

import { useEffect, useRef, useState } from 'react'
import type { LiveScoresResponse } from '@/app/api/live-scores/route'
import s from './sports.module.css'

const AUTO_SPEED = 34
const RESUME_AFTER = 2800
const MIN_COPIES = 3

type DragState = {
  active: boolean
  pointerId: number
  startX: number
  startLeft: number
  lastX: number
  lastAt: number
  velocity: number
}

export default function LiveTicker({ label }: { slateNumber?: number | null; season?: number | null; label?: string | null }) {
  const [data, setData] = useState<LiveScoresResponse | null>(null)
  const [paused, setPaused] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [copyCount, setCopyCount] = useState(4)

  const viewport = useRef<HTMLDivElement>(null)
  const sequence = useRef<HTMLDivElement>(null)
  const sequenceWidth = useRef(0)
  const positioned = useRef(false)
  const interacting = useRef(false)
  const animation = useRef(0)
  const motion = useRef({ lastAt: 0, autoVelocity: 0, inertiaVelocity: 0, resumeAt: 0 })
  const drag = useRef<DragState>({
    active: false,
    pointerId: -1,
    startX: 0,
    startLeft: 0,
    lastX: 0,
    lastAt: 0,
    velocity: 0,
  })

  const hasLive = data?.hasLiveGames ?? false

  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        const response = await fetch('/api/live-scores', { cache: 'no-store' })
        if (response.ok && !dead) setData(await response.json())
      } catch {
        // Keep the last successful scoreboard on a transient network failure.
      }
    }
    load()
    const id = setInterval(load, hasLive ? 30_000 : 300_000)
    return () => {
      dead = true
      clearInterval(id)
    }
  }, [hasLive])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduceMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // Repeat the score sequence enough times to leave a complete spare copy on
  // each side of the viewport. Two copies are not enough on a wide monitor:
  // the browser reaches its maximum scrollLeft before the seamless wrap point.
  useEffect(() => {
    const scroller = viewport.current
    const unit = sequence.current
    if (!scroller || !unit) return

    const measure = () => {
      const width = unit.getBoundingClientRect().width
      if (!width) return
      const previousWidth = sequenceWidth.current
      const phase = previousWidth ? scroller.scrollLeft % previousWidth : 0
      sequenceWidth.current = width
      setCopyCount(Math.max(MIN_COPIES, Math.ceil(scroller.clientWidth / width) + 3))

      if (!positioned.current) {
        scroller.scrollLeft = width
        positioned.current = true
      } else if (previousWidth && Math.abs(previousWidth - width) > 0.5) {
        scroller.scrollLeft = width + phase
      }
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(unit)
    return () => observer.disconnect()
  }, [data])

  useEffect(() => {
    const scroller = viewport.current
    if (!scroller) return
    const motionState = motion.current

    const tick = (now: number) => {
      const state = motion.current
      if (!state.lastAt) state.lastAt = now
      const deltaMs = Math.min(48, now - state.lastAt)
      state.lastAt = now

      const shouldCruise = !paused && !reduceMotion && !interacting.current && now >= state.resumeAt
      const targetVelocity = shouldCruise ? AUTO_SPEED : 0
      const ease = 1 - Math.exp(-deltaMs / 420)
      state.autoVelocity += (targetVelocity - state.autoVelocity) * ease
      state.inertiaVelocity *= Math.exp(-deltaMs / 560)
      if (Math.abs(state.inertiaVelocity) < 0.25) state.inertiaVelocity = 0

      if (!interacting.current) {
        scroller.scrollLeft += (state.autoVelocity + state.inertiaVelocity) * deltaMs / 1000

        const width = sequenceWidth.current
        if (width > 0) {
          // Equivalent copies make this jump visually invisible. Keeping the
          // viewport near the middle also lets a user drag in either direction.
          if (scroller.scrollLeft >= width * 2.25) scroller.scrollLeft -= width
          else if (scroller.scrollLeft <= width * 0.55) scroller.scrollLeft += width
        }
      }

      animation.current = requestAnimationFrame(tick)
    }

    animation.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(animation.current)
      motionState.lastAt = 0
    }
  }, [paused, reduceMotion, data])

  if (!data?.games.length) return null

  const interrupt = () => {
    motion.current.autoVelocity = 0
    motion.current.resumeAt = performance.now() + RESUME_AFTER
  }

  const endDrag = (element: HTMLDivElement, pointerId: number) => {
    if (!drag.current.active || drag.current.pointerId !== pointerId) return
    drag.current.active = false
    interacting.current = false
    motion.current.inertiaVelocity = Math.max(-1600, Math.min(1600, drag.current.velocity))
    motion.current.resumeAt = performance.now() + RESUME_AFTER
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  }

  return (
    <section className={s.ticker} aria-label="Live score scroll">
      <div className={s.tickerLabel}>
        <span>Scoreboard</span>
        <small>{hasLive ? 'Games in progress' : 'College basketball'}</small>
        <button type="button" disabled={reduceMotion} onClick={() => setPaused((value) => !value)}>
          {reduceMotion ? 'Manual scroll' : paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div
        ref={viewport}
        className={s.tickerViewport}
        tabIndex={0}
        aria-label={`${label ?? 'Game scores'}. Drag or scroll horizontally to browse.`}
        onFocus={() => {
          interacting.current = true
          interrupt()
        }}
        onBlur={() => {
          interacting.current = false
          motion.current.resumeAt = performance.now() + RESUME_AFTER
        }}
        onKeyDown={interrupt}
        onWheel={(event) => {
          interrupt()
          motion.current.inertiaVelocity = 0
          if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.preventDefault()
            event.currentTarget.scrollLeft += event.deltaY
          }
        }}
        onTouchStart={() => {
          interacting.current = true
          motion.current.inertiaVelocity = 0
          interrupt()
        }}
        onTouchEnd={() => {
          interacting.current = false
          motion.current.resumeAt = performance.now() + RESUME_AFTER
        }}
        onTouchCancel={() => {
          interacting.current = false
          motion.current.resumeAt = performance.now() + RESUME_AFTER
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') return
          event.currentTarget.setPointerCapture(event.pointerId)
          const now = performance.now()
          drag.current = {
            active: true,
            pointerId: event.pointerId,
            startX: event.clientX,
            startLeft: event.currentTarget.scrollLeft,
            lastX: event.clientX,
            lastAt: now,
            velocity: 0,
          }
          interacting.current = true
          motion.current.inertiaVelocity = 0
          interrupt()
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state.active || state.pointerId !== event.pointerId) return
          event.preventDefault()
          const now = performance.now()
          const elapsed = Math.max(1, now - state.lastAt)
          const delta = state.lastX - event.clientX
          state.velocity = delta / elapsed * 1000
          state.lastX = event.clientX
          state.lastAt = now
          event.currentTarget.scrollLeft = state.startLeft + state.startX - event.clientX
        }}
        onPointerUp={(event) => endDrag(event.currentTarget, event.pointerId)}
        onPointerCancel={(event) => endDrag(event.currentTarget, event.pointerId)}
      >
        <div className={s.tickerTrack}>
          {Array.from({ length: copyCount }, (_, copyIndex) => (
            <div
              ref={copyIndex === 0 ? sequence : undefined}
              className={s.tickerSequence}
              key={copyIndex}
              aria-hidden={copyIndex > 0 || undefined}
            >
              {data.games.map((game) => (
                <div className={s.tickerGame} key={`${copyIndex}-${game.id}`}>
                  <span className={s.tickerStatus} style={game.state === 'in' ? { color: '#b7443e' } : undefined}>
                    {game.state === 'pre'
                      ? game.timeTbd
                        ? 'Time TBD'
                        : `${new Date(game.kickoff).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`
                      : game.statusText}
                  </span>
                  {(['away', 'home'] as const).map((side) => (
                    <div key={side}>
                      <span className={s.logo} style={{ width: 20, height: 20 }}>
                        {game[`${side}Logo` as 'awayLogo' | 'homeLogo'] && (
                          <img src={game[`${side}Logo` as 'awayLogo' | 'homeLogo']!} width={20} height={20} alt="" />
                        )}
                      </span>
                      <b>{side === 'away' ? game.awayTeam : game.homeTeam}</b>
                      <strong>
                        {game.state !== 'pre' && game.scoresKnown !== false
                          ? side === 'away'
                            ? game.awayScore
                            : game.homeScore
                          : '–'}
                      </strong>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
