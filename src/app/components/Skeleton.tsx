import type { CSSProperties, ReactNode } from 'react'

// One gray bar standing in for a piece of content. Size it like the content
// it replaces so nothing shifts when the real data arrives.
export function Bone({
  w = '100%',
  h = 14,
  round = false,
  className = '',
  style,
}: {
  w?: number | string
  h?: number | string
  round?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton ${round ? 'skeleton-round' : ''} ${className}`}
      style={{ width: w, height: h, ...style }}
    />
  )
}

// Wraps a skeleton layout: announces one polite status message and hides the
// bones themselves from assistive tech.
export function SkeletonRegion({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  )
}

// Repeat a skeleton row n times.
export function times(n: number, render: (i: number) => ReactNode) {
  return Array.from({ length: n }, (_, i) => render(i))
}
