import { isTestMode } from '@/lib/testMode'

// Sticky strip shown on every page while this browser is in the testing
// sandbox. Renders nothing (and costs nothing: isTestMode is draft-mode
// gated, so static/ISR pages stay static) during normal slates. Amber means
// "attention" across the site, so it never reads as the season's action color.
export default async function TestModeBanner() {
  if (!(await isTestMode())) return null

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[var(--warning-solid)] bg-warning-tint px-4 py-1.5 text-center text-sm text-ink">
      <span><strong className="font-semibold">Test mode:</strong> sandbox data. Nothing here changes the real pool.</span>
      {/* Plain <a>: a prefetched Link would clear the cookies just by hovering */}
      <a href="/api/test-mode/leave" className="font-semibold text-ink underline">
        Exit test mode
      </a>
    </div>
  )
}
