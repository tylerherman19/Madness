import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import { haveSignupsClosed } from '@/lib/season'
import SignupForm from './SignupForm'

// Re-check every 60s (matches the homepage) so this doesn't freeze at
// whatever haveSignupsClosed() returned at build time — it has to flip to
// closed shortly after the Slate 1 deadline, not stay stuck open for the
// page's lifetime.
export const revalidate = 60

export const metadata = pageMetadata('Join the Pool', 'Create a Pick and Pray account. Read the entry fee, terms, and privacy information before joining.', '/signup', false)

export default async function SignupPage() {
  const signupsClosed = await haveSignupsClosed()

  if (signupsClosed) {
    return (
      <AuthShell title="Sign-ups are closed" description="New entries closed when the first game day locked.">
        <div className="space-y-4">
          <p>Already in the pool? Log in to see your entry and make your pick.</p>
          <Link href="/login" className="btn-primary w-full py-3">Log in</Link>
        </div>
      </AuthShell>
    )
  }

  return <SignupForm />
}
