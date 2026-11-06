import { pageMetadata, supportEmail } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'

export const metadata = pageMetadata('Account Recovery', 'Contact the pool organizer for help recovering access to your account.', '/forgot-pin', false)

export default function ForgotPinPage() {
  return (
    <AuthShell
      title="Forgot your password?"
      description="The pool organizer resets passwords by hand while reset emails are switched off."
      links={[<Link key="login" href="/login">Back to log in</Link>]}
    >
      <div className="space-y-4">
        <p>Email the organizer from the address you joined with. They’ll send you a link to choose a new password.</p>
        <a className="btn-primary w-full py-3" href={`mailto:${supportEmail}?subject=${encodeURIComponent('Pick and Pray password reset')}`}>Email the organizer</a>
        <p>{supportEmail}</p>
      </div>
    </AuthShell>
  )
}
