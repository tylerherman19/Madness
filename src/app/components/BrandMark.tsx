// The Pick and Pray mark (public/logo.png, redrawn as vector). On charcoal it
// is cream and sage, as in the original artwork; on light surfaces the cream
// becomes charcoal and the sage darkens so the mark keeps its contrast.
const TONES = {
  dark: { letter: '#F3EFE3', amp: '#8FB07F' },
  light: { letter: '#1E2227', amp: '#557A45' },
} as const

export default function BrandMark({ size = 30, tone = 'dark' }: { size?: number; tone?: keyof typeof TONES }) {
  const c = TONES[tone]
  return (
    <svg width={size} height={size} viewBox="510 180 460 460" aria-hidden="true" focusable="false">
      <polygon points="548,195 872,195 956,281 872,370 663,370 608,577 528,626 620,316 852,316 884,281 852,250 603,250" fill={c.letter} />
      <polygon points="701,404 747,404 692,577 633,626" fill={c.amp} />
      <text x="748" y="542" fontFamily="Source Sans 3, sans-serif" fontWeight="700" fontSize="150" fill={c.amp}>&amp;</text>
    </svg>
  )
}
