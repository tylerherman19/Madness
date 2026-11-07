import { ImageResponse } from 'next/og'

// The link preview: the P& mark and the name on charcoal, with the accent
// blue as a rule along the bottom.
export const alt = 'Pick and Pray, a college basketball survivor pool: one pick every game day.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// The mark's letter and slash (components/BrandMark.tsx); the ampersand is set
// as text beside it, since the image renderer draws no SVG text.
const MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="510 180 460 460"><polygon points="548,195 872,195 956,281 872,370 663,370 608,577 528,626 620,316 852,316 884,281 852,250 603,250" fill="#F3EFE3"/><polygon points="701,404 747,404 692,577 633,626" fill="#8FB07F"/></svg>')}`

export default function Image() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', background: '#1E2227', color: '#FFFFFF', padding: '0 88px', alignItems: 'center', borderBottom: '16px solid #1A66D2' }}>
      <div style={{ display: 'flex', position: 'relative', width: 260, height: 260, flexShrink: 0 }}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img src={MARK} width={260} height={260} />
        <div style={{ display: 'flex', position: 'absolute', left: 134, top: 118, fontSize: 86, fontWeight: 700, color: '#8FB07F' }}>&amp;</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 64 }}>
        <div style={{ display: 'flex', fontSize: 112, fontWeight: 700, lineHeight: 1, letterSpacing: -2 }}>Pick and Pray</div>
        <div style={{ display: 'flex', fontSize: 38, marginTop: 24, color: '#BDBEBF' }}>College basketball survivor pool</div>
        <div style={{ display: 'flex', fontSize: 38, marginTop: 8, color: '#BDBEBF' }}>Pick a winner every game day. Lose once and you’re out.</div>
      </div>
    </div>,
    size,
  )
}
