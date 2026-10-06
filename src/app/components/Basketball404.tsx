'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './basketball404.module.css'

// One possession, looped: drive, step-back jumper over a contest, swish,
// rebound, outlet pass back out. Every frame is a pure function of time so
// the ball stays in the players' hands and the legs never moonwalk.
const T = 6.4
const FLOOR = 256
const BALL_FLOOR = FLOOR - 12
const DRIBBLE_TOP = 200
const DRIBBLE_P = 2.6 / 6
const RELEASE = 2.52
const SHOT_END = 3.5
const RIM: Pt = [432, 86]
const STILL = 2.8

type Pt = [number, number]
type Pose = { x: number, face: 1 | -1, jy: number, crouch: number, lean: number, feet: [Pt, Pt], hands: [Pt, Pt] }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u
const lerpPt = (a: Pt, b: Pt, u: number): Pt => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)]
const ease = (u: number) => u < .5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1)
const arc = (u: number, h: number) => 4 * h * u * (1 - u)
const n = (v: number) => v.toFixed(1)
const p = (pt: Pt) => `${n(pt[0])} ${n(pt[1])}`

// Two-bone IK: returns the middle joint and the (reach-clamped) end point.
function ik(root: Pt, target: Pt, a: number, b: number, bend: number): [Pt, Pt] {
  const dx = target[0] - root[0], dy = target[1] - root[1]
  const d = clamp(Math.hypot(dx, dy), 1, a + b - .01)
  const th = Math.atan2(dy, dx)
  const al = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1))
  return [[root[0] + a * Math.cos(th + bend * al), root[1] + a * Math.sin(th + bend * al)], [root[0] + d * Math.cos(th), root[1] + d * Math.sin(th)]]
}

function figure(f: Pose) {
  const c = f.crouch, y = f.jy, l = f.lean * f.face
  const hip: Pt = [f.x, 206 + c + y]
  const sh: Pt = [f.x + l, 172 + c * .9 + y]
  const neck: Pt = [f.x + l * 1.15, 160 + c * .9 + y]
  const head: Pt = [f.x + l * 1.3, 147 + c * .9 + y]
  let d = `M${p(neck)}L${p(hip)}`
  for (const foot of f.feet) { const [knee, end] = ik(hip, foot, 27, 27, -f.face); d += `M${p(hip)}L${p(knee)}L${p(end)}` }
  for (const hand of f.hands) { const [elbow, end] = ik(sh, hand, 21, 21, f.face); d += `M${p(sh)}L${p(elbow)}L${p(end)}` }
  return { d, head }
}

// Feet phase off distance travelled, so the planted foot stays put on the floor.
function feet(x: number, speed: number, jy: number, width: number, stride: number, lift: number): [Pt, Pt] {
  const amp = clamp(Math.abs(speed) / 50, 0, 1), ph = x / stride
  return [0, 1].map(i => {
    const q = ph + i * Math.PI, side = i ? 1 : -1
    return [x + side * width * (1 - amp) + amp * stride * Math.sin(q), FLOOR + jy - amp * lift * Math.max(0, Math.cos(q))]
  }) as [Pt, Pt]
}
const speedOf = (fn: (t: number) => number, t: number) => (fn(t + .02) - fn(t - .02)) / .04

function shooterX(t: number) {
  if (t < 1.8) return lerp(80, 232, ease(prog(t, 0, 1.8)))
  if (t < 2.2) return lerp(232, 205, ease(prog(t, 1.8, 2.2)))
  if (t < 3.2) return 205
  if (t < 5.6) return lerp(205, 80, ease(prog(t, 3.2, 5.6)))
  return 80
}
function shooterLift(t: number) {
  let jy = 0, c = 0
  if (t >= 1.8 && t < 2.2) jy = -arc(prog(t, 1.8, 2.2), 9)
  if (t >= 2.2 && t < 2.34) c = 9 * ease(prog(t, 2.2, 2.34))
  if (t >= 2.34 && t < 2.42) c = 9 * (1 - prog(t, 2.34, 2.42))
  if (t >= 2.34 && t < 2.96) jy = -arc(prog(t, 2.34, 2.96), 32)
  if (t >= 2.96 && t < 3.18) c = arc(prog(t, 2.96, 3.18), 8)
  return { jy, c }
}
function defenderX(t: number) {
  if (t < 1.8) return lerp(330, 300, ease(prog(t, 0, 1.8)))
  if (t < 2.1) return lerp(300, 290, ease(prog(t, 1.8, 2.1)))
  if (t < 3.6) return 290
  return lerp(290, 330, ease(prog(t, 3.6, 5.8)))
}
function defenderLift(t: number) {
  let jy = 0, c = 8
  if (t >= 2.24 && t < 2.38) c = 8 + 6 * ease(prog(t, 2.24, 2.38))
  if (t >= 2.38 && t < 2.46) c = 14 - 6 * prog(t, 2.38, 2.46)
  if (t >= 2.38 && t < 2.98) jy = -arc(prog(t, 2.38, 2.98), 34)
  if (t >= 2.98 && t < 3.2) c = 8 + arc(prog(t, 2.98, 3.2), 8)
  return { jy, c }
}
function rebounderX(t: number) {
  if (t < 3.6) return 500
  if (t < 4.25) return lerp(500, 467, ease(prog(t, 3.6, 4.25)))
  if (t < 4.9) return 467
  return lerp(467, 500, ease(prog(t, 4.9, 6.2)))
}
function rebounderLift(t: number) {
  const jy = t >= 4 && t < 4.3 ? -arc(prog(t, 4, 4.3), 8) : 0
  return { jy, c: 4 + 2 * Math.sin(t / T * Math.PI * 8) }
}

const overhead = (t: number): Pt => { const { jy, c } = shooterLift(t); return [shooterX(t) + 10, 116 + c + jy] }
const release = overhead(RELEASE)
// Degrees per px; makes the in-flight backspin offset a whole number of turns.
const SPIN = 1080 / (2 * (RIM[0] - release[0]))

function ball(t: number): Pt {
  if (t < 1.8 || t >= 5.6) {
    const k = ((t - 5.6 + T) % T) / DRIBBLE_P
    return [shooterX(t) + 26, BALL_FLOOR - (BALL_FLOOR - DRIBBLE_TOP) * Math.abs(Math.cos(Math.PI * k))]
  }
  const { jy, c } = shooterLift(t)
  const chest: Pt = [shooterX(t) + 16, 178 + c + jy]
  if (t < 2.2) return lerpPt([232 + 26, DRIBBLE_TOP], chest, ease(prog(t, 1.8, 2.2)))
  if (t < RELEASE) return lerpPt(chest, overhead(t), ease(prog(t, 2.2, RELEASE)))
  if (t < SHOT_END) { const u = prog(t, RELEASE, SHOT_END); return [lerp(release[0], RIM[0], u), lerp(release[1], RIM[1], u) - arc(u, 62)] }
  if (t < 3.72) { const u = prog(t, SHOT_END, 3.72); return [RIM[0], lerp(RIM[1], 140, u * u)] }
  if (t < 3.95) { const u = prog(t, 3.72, 3.95); return [lerp(432, 440, u), lerp(140, BALL_FLOOR, u * u)] }
  if (t < 4.25) { const u = prog(t, 3.95, 4.25); return [lerp(440, 447, u), BALL_FLOOR - (BALL_FLOOR - 196) * (1 - (1 - u) ** 2)] }
  const rx = rebounderX(t)
  if (t < 4.75) return [rx - 20 + 6 * ease(prog(t, 4.5, 4.75)), lerp(196, 182, ease(prog(t, 4.25, 4.5)))]
  const u = prog(t, 4.75, 5.6)
  return [lerp(rebounderX(4.75) - 14, shooterX(5.6) + 26, u), lerp(182, DRIBBLE_TOP, u) - arc(u, 80)]
}

function spin(t: number, bx: number) {
  if (t >= RELEASE && t < SHOT_END) return (2 * release[0] - bx) * SPIN
  return bx * SPIN
}

function frame(t: number) {
  const b = ball(t)

  const sx = shooterX(t), sv = speedOf(shooterX, t), s = shooterLift(t)
  const ph = sx / 12, swing: [Pt, Pt] = [[sx + 10 * Math.sin(ph), 200], [sx - 10 * Math.sin(ph), 200]]
  let sh: [Pt, Pt]
  if (t < 1.8 || t >= 5.6) sh = [[b[0] + 2, Math.min(b[1] - 11, 208)], [sx - 12, 196]]
  else if (t < RELEASE) sh = [[b[0] - 2, b[1] + 11], [b[0] - 10, b[1] + 1]]
  else {
    const follow: [Pt, Pt] = [[sx + 24, 112 + s.c + s.jy], [sx + 12, 120 + s.c + s.jy]]
    const set: [Pt, Pt] = [[release[0] - 2, release[1] + 11], [release[0] - 10, release[1] + 1]]
    const catchPose: [Pt, Pt] = [[b[0] - 6, b[1] - 4], [b[0] - 4, b[1] + 8]]
    const u1 = ease(prog(t, RELEASE, 2.66)), u2 = ease(prog(t, 3.2, 3.5)), u3 = ease(prog(t, 5.3, 5.6))
    sh = [0, 1].map(i => lerpPt(lerpPt(lerpPt(set[i], follow[i], u1), swing[i], u2), catchPose[i], u3)) as [Pt, Pt]
  }
  const shooter = figure({ x: sx, face: 1, jy: s.jy, crouch: s.c, lean: t < 1.8 ? 4 * clamp(sv / 90, 0, 1) : 0, feet: feet(sx, sv, s.jy, 9, 12, 9), hands: sh })

  const dx = defenderX(t), dv = speedOf(defenderX, t), dl = defenderLift(t)
  const wiggle = 3 * Math.sin(t / T * Math.PI * 16)
  const guard: [Pt, Pt] = [[dx - 26, 168 + dl.c + wiggle], [dx + 20, 196 + dl.c - wiggle]]
  const contest: [Pt, Pt] = [[dx - 10, 112 + dl.jy], [dx + 8, 126 + dl.jy]]
  const cu = ease(prog(t, 2.28, 2.4)) * (1 - ease(prog(t, 3, 3.4)))
  const defender = figure({ x: dx, face: -1, jy: dl.jy, crouch: dl.c, lean: 3, feet: feet(dx, dv, dl.jy, 16, 8, 5), hands: [lerpPt(guard[0], contest[0], cu), lerpPt(guard[1], contest[1], cu)] })

  const rx = rebounderX(t), rv = speedOf(rebounderX, t), rl = rebounderLift(t)
  const ready: [Pt, Pt] = [[rx - 14, 176 + rl.c], [rx + 12, 182 + rl.c]]
  const hold: [Pt, Pt] = [[b[0] + 8, b[1] + 5], [b[0] + 6, b[1] - 6]]
  const push: [Pt, Pt] = [[rx - 30, 140], [rx - 24, 136]]
  const hu = t < 4.25 ? ease(prog(t, 3.95, 4.25)) : t < 4.75 ? 1 : 0
  const pu = ease(prog(t, 4.75, 4.9)) * (1 - ease(prog(t, 5, 5.5)))
  const rh = [0, 1].map(i => lerpPt(lerpPt(ready[i], hold[i], hu), push[i], pu)) as [Pt, Pt]
  const rebounder = figure({ x: rx, face: -1, jy: rl.jy, crouch: rl.c, lean: 2, feet: feet(rx, rv, rl.jy, 10, 12, 8), hands: rh })

  const height = clamp((BALL_FLOOR - b[1]) / 260, 0, 1)
  const net = arc(prog(t, SHOT_END, 3.86), 1)
  const e = 12 * net, sway = 2 * net
  const swish = prog(t, 3.55, 4.35)

  return {
    shooter, defender, rebounder,
    shadows: [[sx, s.jy], [dx, dl.jy], [rx, rl.jy]] as Pt[],
    ball: `translate(${p(b)}) rotate(${n(spin(t, b[0]) % 360)})`,
    ballShadow: { cx: b[0], rx: 11 * (1 - height * .6), opacity: .28 * (1 - height * .7) },
    net: `M419 101L${n(425 + sway)} ${n(124 + e)}H${n(440 + sway)}L446 101M420 104L${n(440 + sway)} ${n(119 + e)}M444 104L${n(426 + sway)} ${n(119 + e)}`,
    swish: { opacity: swish > 0 && swish < 1 ? Math.min(1, arc(swish, 2)) : 0, y: 66 - 12 * swish },
  }
}

type Frame = ReturnType<typeof frame>
const PLAYERS = ['shooter', 'defender', 'rebounder'] as const

function apply(svg: SVGSVGElement, f: Frame) {
  const q = (part: string) => svg.querySelector(`[data-part="${part}"]`)
  PLAYERS.forEach((name, i) => {
    q(`${name}-body`)?.setAttribute('d', f[name].d)
    q(`${name}-head`)?.setAttribute('cx', n(f[name].head[0]))
    q(`${name}-head`)?.setAttribute('cy', n(f[name].head[1]))
    const [x, jy] = f.shadows[i], shadow = q(`${name}-shadow`)
    shadow?.setAttribute('cx', n(x))
    shadow?.setAttribute('rx', n(20 + jy * .3))
  })
  q('ball')?.setAttribute('transform', f.ball)
  const bs = q('ball-shadow')
  bs?.setAttribute('cx', n(f.ballShadow.cx))
  bs?.setAttribute('rx', n(f.ballShadow.rx))
  bs?.setAttribute('opacity', f.ballShadow.opacity.toFixed(2))
  q('net')?.setAttribute('d', f.net)
  const sw = q('swish')
  sw?.setAttribute('opacity', f.swish.opacity.toFixed(2))
  sw?.setAttribute('y', n(f.swish.y))
}

const COLORS = { shooter: '#0b55bf', defender: '#0d1c34', rebounder: '#536175' }

export default function Basketball404() {
  const [paused, setPaused] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const clock = useRef(0)
  const initial = frame(0)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(svg, frame(STILL)); return }
    if (paused) return
    let raf = 0, last = performance.now()
    const tick = () => {
      const now = performance.now()
      clock.current = (clock.current + Math.min(now - last, 50) / 1000) % T
      last = now
      apply(svg, frame(clock.current))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [paused])

  return <div className={styles.scene}>
    <svg ref={svgRef} viewBox="0 0 560 310" role="img" aria-labelledby="basketball-404-title" className={styles.court}>
      <title id="basketball-404-title">Animated stick figures playing basketball: a player dribbles at a defender, hits a step-back jumper over the contest, and a teammate rebounds and throws an outlet pass back out.</title>
      <rect x="2" y="2" width="556" height="306" rx="20" fill="#eef3fb" />
      <rect x="2" y="256" width="556" height="52" fill="#e3ebf6" />
      <path d="M25 256H535M370 256V172H512M370 172Q324 213 370 256" fill="none" stroke="#b9cbe3" strokeWidth="3" />
      <text x="36" y="84" fill="#dce5f2" fontSize="64" fontWeight="800" fontFamily="Arial, sans-serif" letterSpacing="4">404</text>
      <path d="M485 254V49H449" fill="none" stroke="#536175" strokeWidth="6" strokeLinecap="round" />
      <rect x="442" y="29" width="8" height="78" rx="3" fill="#0d1c34" />
      <g fill="#0d1c34">
        {PLAYERS.map((name, i) => <ellipse key={name} data-part={`${name}-shadow`} cx={n(initial.shadows[i][0])} cy="258" rx="20" ry="3.5" opacity=".14" />)}
        <ellipse data-part="ball-shadow" cx={n(initial.ballShadow.cx)} cy="258" rx={n(initial.ballShadow.rx)} ry="3" opacity={initial.ballShadow.opacity.toFixed(2)} />
      </g>
      {PLAYERS.map(name => <g key={name} color={COLORS[name]} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path data-part={`${name}-body`} d={initial[name].d} />
        <circle data-part={`${name}-head`} cx={n(initial[name].head[0])} cy={n(initial[name].head[1])} r="12" fill="#eef3fb" />
      </g>)}
      <g data-part="ball" transform={initial.ball}>
        <circle r="12" fill="#c1481d" stroke="#783313" strokeWidth="2" />
        <path d="M-12 0H12M0 -12V12M-8 -9Q5 0 -8 9M8 -9Q-5 0 8 9" fill="none" stroke="#783313" strokeWidth="1.5" />
      </g>
      <path data-part="net" d={initial.net} fill="none" stroke="#536175" strokeWidth="2" strokeLinejoin="round" />
      <path d="M416 98H449" stroke="#c1481d" strokeWidth="5" strokeLinecap="round" />
      <text data-part="swish" x="380" y="66" opacity="0" textAnchor="middle" fill="#0b55bf" fontSize="18" fontWeight="800" fontFamily="Arial, sans-serif" letterSpacing="2">SWISH!</text>
      <text x="25" y="292" fill="#536175" fontSize="13" fontFamily="Arial, sans-serif">WRONG PAGE. RIGHT GAME.</text>
    </svg>
    <button className={styles.toggle} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume animation' : 'Pause animation'}</button>
  </div>
}
