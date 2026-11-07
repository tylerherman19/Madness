import { isTestMode } from '@/lib/testMode'

// Sticky strip shown on every page while this browser is in the testing
// sandbox. Renders nothing (and costs nothing: isTestMode is draft-mode
// gated, so static/ISR pages stay static) during normal slates. Charcoal with
// an amber label, so it reads as a warning and never as the page's action.
export default async function TestModeBanner() {
  if (!(await isTestMode())) return null

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-[var(--surface-inverse)] px-4 py-1.5 text-center text-sm text-[var(--on-inverse)]">
      <span><strong className="font-semibold text-[#FFC46B]">Test mode:</strong> sandbox data. Nothing here changes the real pool.</span>
      {/* Plain <a>: a prefetched Link would clear the cookies just by hovering */}
      <a href="/api/test-mode/leave" className="font-semibold text-[var(--on-inverse)] underline">
        Exit test mode
      </a>
    </div>
  )
}
