import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export const metadata = pageMetadata('Account Recovery', 'Contact the Madness organizer for help recovering access to your account.', '/forgot-pin', false)

export default function ForgotPinPage() {
  return (
    <AuthShell eyebrow="Account recovery" title="Forgot your password?" description="Ask the pool organizer to request a reset link for your account.">
          <div className="border p-6 text-center" style={{ borderColor: 'var(--line)' }}>
            <p className="font-bold" style={{ color: 'var(--ink)' }}>Ask the pool organizer</p>
            <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
              The organizer can request a reset link for your account. Email delivery is being set up, so reset links are not being sent yet.
            </p>
          </div>
          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm font-bold underline" style={{ color: 'var(--muted)' }}>Back to log in</Link>
          </div>
    </AuthShell>
  )
}
