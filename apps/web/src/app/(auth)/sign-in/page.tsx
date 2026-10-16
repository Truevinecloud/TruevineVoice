import { redirect } from 'next/navigation';

import { currentSession } from '../../../lib/session';

import { SignInForm } from './SignInForm';

/**
 * `/sign-in`
 *
 * Redirects an already-signed-in caller to the dashboard rather than showing a
 * form they do not need.
 *
 * `searchParams` is a Promise in Next.js 16, so it is awaited. `reason` lets the
 * app shell say *why* the user is back here: an expired session and a first visit
 * need different wording, and silently redirecting an expired session makes it
 * look as though the sign-in failed.
 */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly reason?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (session.ok) redirect('/app');

  const params = await searchParams;
  const raw = params.reason;
  const reason = Array.isArray(raw) ? raw[0] : raw;

  return (
    <main className="auth-shell">
      <h1>Sign in</h1>
      <p className="auth-subtitle">Truevine Voice customer portal.</p>

      {reason === 'session-ended' && (
        <p className="notice notice-info" role="status">
          Your session ended. Sign in again to continue.
        </p>
      )}

      <SignInForm />

      <div className="auth-links">
        <a href="/forgot-password">Forgot your password?</a>
      </div>
    </main>
  );
}
