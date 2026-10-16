import Link from 'next/link';

import { currentSession } from '../../../lib/session';

import { AcceptInvitationForm } from './AcceptInvitationForm';

/**
 * `/accept-invite`
 *
 * `searchParams` is a Promise in Next.js 16, so it is awaited.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly token?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const raw = params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (token === undefined || token.length === 0) {
    return (
      <main className="auth-shell">
        <h1>Invitation</h1>
        <p className="auth-subtitle">
          This invitation link is incomplete. Ask whoever invited you to send it again.
        </p>
        <div className="auth-links">
          <Link href="/sign-in">Go to sign in</Link>
        </div>
      </main>
    );
  }

  const session = await currentSession();

  return (
    <main className="auth-shell">
      <h1>You have been invited</h1>
      <p className="auth-subtitle">
        Accepting adds you to the organization that invited you, with the role they chose. You can
        leave at any time by asking an owner.
      </p>

      {session.ok ? (
        <AcceptInvitationForm token={token} />
      ) : (
        <>
          <p className="notice notice-info">
            Sign in first so we know who is joining, then open this link again.
          </p>
          <div className="auth-links">
            <Link href="/sign-in">Sign in</Link>
          </div>
        </>
      )}
    </main>
  );
}
