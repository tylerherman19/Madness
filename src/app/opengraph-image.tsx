import { ImageResponse } from 'next/og'

export const alt = 'MADNESS — College Basketball Survivor. One pick. Every game day.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
  return new ImageResponse(<div style={{ display: 'flex', width: '100%', height: '100%', background: '#0d1c34', color: '#fff', padding: 72, flexDirection: 'column', justifyContent: 'center', borderBottom: '18px solid #4e84d8' }}>
    <div style={{ display: 'flex', fontSize: 28, letterSpacing: 5, color: '#bdd5fa' }}>COLLEGE BASKETBALL SURVIVOR</div>
    <div style={{ display: 'flex', fontSize: 140, fontWeight: 700, marginTop: 28, letterSpacing: -6 }}>MADNESS</div>
    <div style={{ display: 'flex', fontSize: 40, marginTop: 22 }}>One pick. Every game day. Stay alive.</div>
  </div>, size)
}
