'use client'
/* eslint-disable @next/next/no-img-element -- ESPN supplies tiny 20px scoreboard marks; the optimizer adds no value here. */

import { useEffect, useRef, useState } from 'react'
import type { LiveScoresResponse } from '@/app/api/live-scores/route'
import s from './sports.module.css'

// The ticker is one continuous velocity, never a stop-and-restart. Left alone it
// cruises; a swipe injects velocity; friction relaxes that velocity back toward
// the cruise speed instead of toward zero, so a throw coasts, decays, and slides
// straight back into the normal drift with no seam.
const CRUISE = 34 // px/s the strip drifts at when nobody is touching it
const SETTLE_TAU = 620 // ms time constant for velocity relaxing back to CRUISE
const TRACKING_TAU = 45 // ms smoothing on the velocity sampled from the pointer
const MAX_FLICK = 3400 // px/s cap so a violent swipe still stays readable
const HOLD_TIMEOUT = 90 // ms of stillness before release that cancels the throw
const KEY_NUDGE = 420 // px/s impulse from one arrow key press
const WHEEL_GAIN = 14 // px/s of velocity carried per px of wheel delta
const MIN_COPIES = 3

type Drag = {
  active: boolean
  pointerId: number
  lastX: number
  lastAt: number
}

export default function LiveTicker({ label }: { slateNumber?: number | null; season?: number | null; label?: string | null }) {
  const [data, setData] = useState<LiveScoresResponse | null>(null)
  const [paused, setPaused] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [copyCount, setCopyCount] = useState(MIN_COPIES)

  const viewport = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const sequence = useRef<HTMLDivElement>(null)

  const sequenceWidth = useRef(0)
  const offset = useRef(0)
  const velocity = useRef(CRUISE)
  const cruising = useRef(true)
  const drag = useRef<Drag>({ active: false, pointerId: -1, lastX: 0, lastAt: 0 })

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

  // The cruise target is read inside the animation frame, so keep it on a ref:
  // toggling pause must bend the current velocity, not restart the loop.
  useEffect(() => {
    cruising.current = !paused && !reduceMotion
  }, [paused, reduceMotion])

  // Repeat the score sequence enough times to cover the viewport plus one spare
  // copy, which is what lets the modular wrap below stay invisible.
  useEffect(() => {
    const scroller = viewport.current
    const unit = sequence.current
    if (!scroller || !unit) return

    const measure = () => {
      const width = unit.getBoundingClientRect().width
      if (!width) return
      sequenceWidth.current = width
      setCopyCount(Math.max(MIN_COPIES, Math.ceil((scroller.clientWidth + width) / width) + 1))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(unit)
    return () => observer.disconnect()
  }, [data])

  useEffect(() => {
    const strip = track.current
    if (!strip) return

    let frame = 0
    let last = 0

    const draw = () => {
      const width = sequenceWidth.current
      // One sequence is indistinguishable from the next, so folding the offset
      // back into [0, width) keeps the strip endless without any visible jump.
      if (width > 0) offset.current = ((offset.current % width) + width) % width
      strip.style.transform = `translate3d(${-offset.current}px, 0, 0)`
    }

    const tick = (now: number) => {
      if (!last) last = now
      const deltaMs = Math.min(48, now - last)
      last = now

      if (!drag.current.active) {
        const target = cruising.current ? CRUISE : 0
        const ease = 1 - Math.exp(-deltaMs / SETTLE_TAU)
        velocity.current += (target - velocity.current) * ease
        if (target === 0 && Math.abs(velocity.current) < 0.15) velocity.current = 0
        offset.current += (velocity.current * deltaMs) / 1000
      }

      draw()
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [data])

  // React listens for wheel passively at the root, so preventDefault only takes
  // effect from a listener we attach ourselves.
  useEffect(() => {
    const scroller = viewport.current
    if (!scroller) return

    const onWheel = (event: WheelEvent) => {
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX
      if (!horizontal || (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) return
      event.preventDefault()
      offset.current += horizontal
      // Carry the wheel into velocity too, so letting go of the wheel coasts
      // back to cruise the same way a released swipe does.
      velocity.current = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, horizontal * WHEEL_GAIN))
    }

    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [data])

  if (!data?.games.length) return null

  const release = (element: HTMLDivElement, pointerId: number) => {
    const state = drag.current
    if (!state.active || state.pointerId !== pointerId) return
    state.active = false
    // A pointer parked in place is a deliberate hold, not a throw: let it fall
    // back to cruise from a standstill rather than firing off a stale velocity.
    if (performance.now() - state.lastAt > HOLD_TIMEOUT) velocity.current = 0
    velocity.current = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, velocity.current))
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
        role="group"
        aria-label={`${label ?? 'Game scores'}. Drag or use the arrow keys to browse.`}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          velocity.current = event.key === 'ArrowRight' ? KEY_NUDGE : -KEY_NUDGE
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.pointerType === 'mouse') return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            active: true,
            pointerId: event.pointerId,
            lastX: event.clientX,
            lastAt: performance.now(),
          }
          // Grabbing catches the strip mid-coast, exactly like pinning a
          // spinning wheel: whatever momentum it had is now yours.
          velocity.current = 0
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state.active || state.pointerId !== event.pointerId) return
          const now = performance.now()
          const deltaMs = Math.max(1, now - state.lastAt)
          const deltaX = event.clientX - state.lastX
          state.lastX = event.clientX
          state.lastAt = now
          // Dragging right reveals earlier games, which means a smaller offset.
          offset.current -= deltaX
          const sample = (-deltaX / deltaMs) * 1000
          const ease = 1 - Math.exp(-deltaMs / TRACKING_TAU)
          velocity.current += (sample - velocity.current) * ease
        }}
        onPointerUp={(event) => release(event.currentTarget, event.pointerId)}
        onPointerCancel={(event) => release(event.currentTarget, event.pointerId)}
        onLostPointerCapture={(event) => release(event.currentTarget, event.pointerId)}
      >
        <div className={s.tickerTrack} ref={track}>
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
