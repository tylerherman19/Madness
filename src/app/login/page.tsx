import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import { haveSignupsClosedCached } from '@/lib/season'
import LoginForm from './LoginForm'

export default async function LoginPage() {
  const closed = await haveSignupsClosedCached()
  return (
    <AuthShell
      title="Log in"
      description="Use the email and password you chose when you joined."
      links={[
        <Link key="forgot" href="/forgot-pin">Forgot your password?</Link>,
        closed
          ? <span key="closed">Sign-ups are closed for this season.</span>
          : <span key="join">New to the pool? <Link href="/signup">Join the pool</Link></span>,
      ]}
    >
      <LoginForm />
    </AuthShell>
  )
}
