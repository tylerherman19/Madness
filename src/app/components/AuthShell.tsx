'use client'

import SiteHeader from './SiteHeader'

export default function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="site-shell auth-shell min-h-screen">
      <SiteHeader />
      <main className="content-width py-8 sm:py-12">
        <div className="auth-panel mx-auto grid max-w-4xl overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-bright)] lg:grid-cols-[1.15fr_.85fr]">
        <section className="flex items-center p-7 sm:p-10 lg:p-14">
          <div className="w-full max-w-md mx-auto">
            <p className="text-sm font-bold" style={{ color: 'var(--orange-dark)' }}>{eyebrow}</p>
            <h1 className="font-display mt-1 text-5xl leading-none">{title}</h1>
            <p className="mt-3 mb-8 text-sm leading-6" style={{ color: 'var(--muted)' }}>{description}</p>
            {children}
          </div>
        </section>
        <aside className="auth-guide relative border-t border-[var(--line)] bg-[var(--court)] p-7 sm:p-10 lg:border-l lg:border-t-0 lg:p-12">
          <div className="relative z-10">
            <p className="font-display text-3xl">How it works</p>
            <ol className="mt-6 space-y-0">
              {[
                ['1', 'Choose one team', 'Pick from the current game-day board.'],
                ['2', 'Win and advance', 'A loss ends your run.'],
                ['3', 'Do not repeat', 'Each team can be used once per season.'],
              ].map(([number, label, note]) => (
                <li key={number} className="flex gap-4 border-t border-[var(--line-strong)] py-4 first:border-t-2 first:border-t-[var(--ink)]">
                  <span className="font-display text-2xl text-[var(--orange-dark)]">{number}</span>
                  <span><strong className="block text-sm">{label}</strong><small className="mt-1 block text-xs leading-5 text-[var(--muted)]">{note}</small></span>
                </li>
              ))}
            </ol>
            <p className="mt-7 border-l-2 border-[var(--orange)] pl-3 text-xs font-semibold leading-5 text-[var(--muted)]">Picks lock when the first game tips. You can change your team until then.</p>
          </div>
        </aside>
        </div>
      </main>
    </div>
  )
}
