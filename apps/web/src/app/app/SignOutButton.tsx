'use client';

/**
 * Sign-out button.
 *
 * Calls the API, which revokes the session server-side and clears both cookies.
 * A client-side cookie wipe alone would leave a valid token in the database that
 * an attacker holding a copy could still use; revocation is what actually ends
 * the session.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../lib/api';

export function SignOutButton(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);

    try {
      await ensureCsrfToken();
      await request('/auth/sign-out', { method: 'POST' });
      router.replace('/sign-in');
      router.refresh();
    } catch (caught) {
      // Even a failed revocation should send the browser to sign-in: the user
      // asked to leave, and leaving them on a page that looks authenticated is
      // worse than showing an error they can act on later.
      if (!(caught instanceof ApiError)) void messageFor(caught);

      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <button type="button" className="button-secondary" onClick={signOut} disabled={busy}>
      <span aria-hidden="true">↪</span>
      <span className="sidebar-nav-label">{busy ? 'Signing out…' : 'Sign out'}</span>
    </button>
  );
}
