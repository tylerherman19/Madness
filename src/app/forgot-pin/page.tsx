import { pageMetadata, supportEmail } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export const metadata = pageMetadata('Account Recovery', 'Contact the pool organizer for help recovering access to your account.', '/forgot-pin', false)

export default function ForgotPinPage() {
  return (
    <AuthShell
      title="Forgot your password?"
      description="The pool organizer resets passwords by hand. No reset email is sent."
      links={[<Link key="login" href="/login">Back to log in</Link>]}
    >
      <div className="space-y-4">
        <p>Email the organizer from the address you joined with. They’ll give you a one-time link to choose a new password. It works once and expires after 60 minutes.</p>
        <a className="btn-primary w-full py-3" href={`mailto:${supportEmail}?subject=${encodeURIComponent('Pick and Pray password reset')}`}>Email the organizer</a>
        <p>{supportEmail}</p>
      </div>
    </AuthShell>
  )
}
