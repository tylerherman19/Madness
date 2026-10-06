'use client'

import { useState } from 'react'

interface Props {
  slateNumber: number
  recapText: string
}

export default function RecapClient({ slateNumber, recapText }: Props) {
  const [copied, setCopied] = useState(false)

  async function copyToClipboard() {
    await navigator.clipboard.writeText(recapText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        Slate {slateNumber} recap — copy and paste into GroupMe.
      </p>
      <div className="relative">
        <pre className="rounded-xl border border-line bg-surface p-4 text-sm text-ink whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-[600px]">
          {recapText || 'No data yet — enter results first.'}
        </pre>
        {recapText && (
          <button
            onClick={copyToClipboard}
            className="absolute top-3 right-3 rounded-lg bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-line hover:text-ink transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  )
}
