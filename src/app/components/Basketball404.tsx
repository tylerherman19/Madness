'use client'

import { useState } from 'react'
import styles from './basketball404.module.css'

function Player({ defender = false }: { defender?: boolean }) {
  return <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="0" cy="-38" r="12" />
    <path d="M0 -26V22" />
    <g className={defender ? styles.defenderArms : styles.shooterArms}>
      <path d={defender ? 'M0 -12L-22 -27L-30 -49M0 -12L22 -27L30 -49' : 'M0 -12L20 0L35 -10M0 -12L-18 1L-27 -8'} />
    </g>
    <path className={styles.leftLeg} d="M0 22L-12 47L-23 70" />
    <path className={styles.rightLeg} d="M0 22L14 46L22 70" />
  </g>
}

export default function Basketball404() {
  const [paused, setPaused] = useState(false)
  return <div className={`${styles.scene} ${paused ? styles.paused : ''}`}>
    <svg viewBox="0 0 560 310" role="img" aria-labelledby="basketball-404-title" className={styles.court}>
      <title id="basketball-404-title">Animated stick figures playing basketball: a player dribbles past a defender and shoots a basket.</title>
      <rect x="2" y="2" width="556" height="306" rx="20" fill="#eef3fb" />
      <path d="M25 256H535M370 256V172H512M370 172Q324 213 370 256" fill="none" stroke="#b9cbe3" strokeWidth="3" />
      <path d="M485 254V49H449" fill="none" stroke="#536175" strokeWidth="6" strokeLinecap="round" />
      <rect x="442" y="29" width="8" height="78" rx="3" fill="#0d1c34" />
      <path d="M416 98H449" stroke="#c1481d" strokeWidth="5" strokeLinecap="round" />
      <path className={styles.net} d="M419 101L425 124H440L446 101M420 104L440 119M444 104L426 119" fill="none" stroke="#536175" strokeWidth="2" />
      <g transform="translate(90 184)" color="#0b55bf"><g className={styles.shooter}><Player /></g></g>
      <g transform="translate(303 184)" color="#0d1c34"><g className={styles.defender}><Player defender /></g></g>
      <g transform="translate(496 184)" color="#536175"><g className={styles.rebounder}><Player /></g></g>
      <g className={styles.ball}>
        <circle r="12" fill="#c1481d" stroke="#783313" strokeWidth="2" />
        <path d="M-12 0H12M0 -12V12M-8 -9Q5 0 -8 9M8 -9Q-5 0 8 9" fill="none" stroke="#783313" strokeWidth="1.5" />
      </g>
      <text x="25" y="292" fill="#536175" fontSize="13" fontFamily="Arial, sans-serif">WRONG PAGE. RIGHT GAME.</text>
    </svg>
    <button className={styles.toggle} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume animation' : 'Pause animation'}</button>
  </div>
}
