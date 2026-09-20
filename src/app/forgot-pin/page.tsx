import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export default function ForgotPinPage() {
  return (
    <AuthShell eyebrow="Account recovery" title="Forgot your password?" description="Password resets are handled by the pool organizer so nobody can take over an entry with only an email address.">
          <div className="border p-6 text-center" style={{ borderColor: 'var(--border)' }}>
            <p className="font-bold" style={{ color: 'var(--dark)' }}>Ask the pool organizer</p>
            <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
              The organizer can set a temporary password for your entry. You can then log in without waiting for an email.
            </p>
          </div>
          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm font-bold underline" style={{ color: 'var(--muted)' }}>Back to log in</Link>
          </div>
    </AuthShell>
  )
}
