import { redirect } from 'next/navigation';

import { currentSession } from '../../lib/session';

import { AppNavigation } from './AppNavigation';
import { Suspense } from 'react';

/**
 * The authenticated application shell.
 *
 * Two guards, in order, both of which the API also enforces. The server-side
 * check exists to avoid flashing private UI at somebody who is not signed in; it
 * is **not** the security boundary. Hiding a link is a courtesy, and every route
 * behind this layout re-checks the session and the permission server-side.
 *
 *   1. No usable session -> `/sign-in`. An expired or revoked session says so
 *      rather than pretending to be signed out, because "your session expired" and
 *      "you are not signed in" need different user actions.
 *   2. Terms not accepted -> `/accept-terms`.
 */

export default async function AppLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (!session.ok) {
    if (session.failure.kind === 'expired' || session.failure.kind === 'revoked') {
      redirect('/sign-in?reason=session-ended');
    }

    redirect('/sign-in');
  }

  if (!session.me.termsAccepted) {
    redirect('/accept-terms');
  }

  return (
    <div className="app-shell">
      <Suspense
        fallback={
          <div className="app-navigation-loading" role="status">
            Loading your workspace navigation…
          </div>
        }
      >
        <AppNavigation memberships={session.me.memberships} email={session.me.email} />
      </Suspense>

      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
