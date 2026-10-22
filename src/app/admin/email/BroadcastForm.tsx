'use client'

import Link from 'next/link'
import { useRef,useState } from 'react'
import { TONE_ROLE, TONE_TEXT_CLASS, type StatusMessage } from '../statusTone'

type Audience = 'all' | 'alive' | 'unpicked'

interface Props {
  counts: { all: number; alive: number; unpicked: number | null }
  slateNumber: number | null
}

export default function BroadcastForm({ counts, slateNumber }: Props) {
  const requestId=useRef<string | null>(null)
  const [receipt,setReceipt]=useState<string | null>(null)
  const [audience, setAudience] = useState<Audience>('alive')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)

  const audienceCount =
    audience === 'all' ? counts.all : audience === 'alive' ? counts.alive : counts.unpicked ?? 0

  async function handleSend() {
    if (!subject.trim() || !message.trim()) {
      setStatus({ tone: 'error', text: 'Error: subject and message are both required.' })
      return
    }
    if (!confirm(`Queue this announcement for ${audienceCount} player${audienceCount === 1 ? '' : 's'}? Delivery follows the configured email mode.`)) return

    requestId.current ??= crypto.randomUUID()
    setSending(true)
    setStatus({ tone: 'info', text: 'Recording campaign…' })
    try {
      const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id:requestId.current, subject: subject.trim(), message: message.trim(), audience }),
      })
      const data = await res.json()
      if (res.ok) {
        setStatus({
          tone: 'ok',
          text: 'Campaign recorded. Recipient expansion and delivery run independently.',
        })
        setReceipt(data.progressUrl)
        requestId.current=null
        setSubject('')
        setMessage('')
      } else {
        setStatus({ tone: 'error', text: `Error: ${data.error}` })
      }
    } catch {
      setStatus({ tone: 'error', text: 'Server error. Try again.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
      <div>
        <label htmlFor="broadcastform-audience" className="block text-xs font-medium uppercase tracking-wide text-muted mb-1.5">
          Audience
        </label>
        <select id="broadcastform-audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value as Audience)}
          className="w-full rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink"
        >
          <option value="alive">Alive players ({counts.alive})</option>
          <option value="all">All players ({counts.all})</option>
          <option value="unpicked" disabled={counts.unpicked === null}>
            {counts.unpicked === null
              ? 'No pick yet — needs an active slate'
              : `Incomplete quota for Slate ${slateNumber} (${counts.unpicked})`}
          </option>
        </select>
      </div>

      <div>
        <label htmlFor="broadcastform-subject" className="block text-xs font-medium uppercase tracking-wide text-muted mb-1.5">
          Subject
        </label>
        <input id="broadcastform-subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={150}
          placeholder="e.g. Slate 5 picks due Sunday at noon!"
          className="w-full rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink placeholder:text-muted"
        />
      </div>

      <div>
        <label htmlFor="broadcastform-message" className="block text-xs font-medium uppercase tracking-wide text-muted mb-1.5">
          Message
        </label>
        <textarea id="broadcastform-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={8}
          maxLength={5000}
          placeholder={'Reminder: get your picks in before Sunday 12 PM CT.\n\nStandings: https://…'}
          className="w-full rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink placeholder:text-muted"
        />
        <p className="mt-1 text-xs text-muted">
          Each email opens with &ldquo;Hey &lt;first name&gt;,&rdquo; automatically.
        </p>
      </div>

      <button
        onClick={handleSend}
        disabled={sending || audienceCount === 0 || !subject.trim() || !message.trim()}
        className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50 transition-colors"
      >
        {sending ? 'Recording…' : `Queue for ${audienceCount} player${audienceCount === 1 ? '' : 's'}`}
      </button>

<p>Counts are current estimates. Membership is recorded during audience expansion; preferences are checked before delivery.</p>
      {receipt && <Link href={receipt}>Open campaign delivery progress</Link>}
      <details><summary>Preview</summary><h3>{subject}</h3><p style={{whiteSpace:'pre-wrap'}}>{message}</p></details>
      {status && (
        <p role={TONE_ROLE[status.tone]} className={`text-sm ${TONE_TEXT_CLASS[status.tone]}`}>{status.text}</p>
      )}
    </div>
  )
}
