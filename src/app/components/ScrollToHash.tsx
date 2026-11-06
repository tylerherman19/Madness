'use client'

import { useEffect } from 'react'

// Today's Standings and Rules links (/#standings, /#rules) are followed from
// other pages. The page arrives behind a loading screen, so the browser's own
// jump to the section finds nothing to jump to; this makes it once the page
// is in.
export default function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (!id) return
    document.getElementById(id)?.scrollIntoView({ behavior: 'instant' })
  }, [])
  return null
}
