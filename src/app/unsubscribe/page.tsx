import { pageMetadata } from '@/lib/site'
import { verifyUnsubscribe } from '@/lib/unsubscribe'
import AuthShell from '@/app/components/AuthShell'
import UnsubscribeForm from './UnsubscribeForm'

export const metadata = pageMetadata('Unsubscribe', 'Stop Pick and Pray pool emails.', '/unsubscribe', false)

// Opening the link changes nothing: some mail scanners open every link, so
// the change waits for a button press.
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ p?: string; t?: string }> }) {
  const { p, t } = await searchParams
  const valid = verifyUnsubscribe(p, t)
  return (
    <AuthShell title="Pool emails" description={valid ? 'Reminders, pick confirmations and pool updates.' : undefined}>
      {valid ? <UnsubscribeForm p={p!} t={t!} /> : <p>This unsubscribe link is not valid. Use the link from your most recent pool email.</p>}
    </AuthShell>
  )
}
