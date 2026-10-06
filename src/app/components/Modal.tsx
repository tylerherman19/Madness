'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Accessible modal shell: announced as a dialog with its title, moves focus
// inside on open, keeps Tab within it, closes on Escape, and hands focus back
// to whatever opened it.
export default function Modal({
  titleId,
  onClose,
  children,
  width = 'max-w-sm',
}: {
  titleId: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Captured at first render, before focus moves into the dialog.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)))
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  useEffect(() => {
    const node = panel.current
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [opener])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'color-mix(in srgb, var(--surface-inverse) 55%, transparent)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`w-full ${width}`}>
        {children}
      </div>
    </div>
  )
}
