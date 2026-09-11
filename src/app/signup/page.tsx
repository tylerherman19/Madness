import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import { haveSignupsClosed } from '@/lib/season'
import SignupForm from './SignupForm'

// Re-check every 60s (matches the homepage) so this doesn't freeze at
// whatever haveSignupsClosed() returned at build time — it has to flip to
// closed shortly after the Slate 1 deadline, not stay stuck open for the
// page's lifetime.
export const revalidate = 60

export default async function SignupPage() {
  const signupsClosed = await haveSignupsClosed()

  if (signupsClosed) {
    return (
      <AuthShell eyebrow="Registration closed" title="The pool is underway" description="New entries close when the first game day locks.">
          <div className="card p-6 sm:p-8 text-center space-y-4">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Slate 1 picks have locked, so new entries aren&apos;t accepted anymore. Already signed up?
            </p>
            <Link href="/login" className="btn-primary inline-flex px-6 py-3">
              Log in
            </Link>
            <Link href="/" className="block text-sm font-bold" style={{ color: 'var(--muted)' }}>Back to the pool</Link>
          </div>
      </AuthShell>
    )
  }

  return <SignupForm />
}
