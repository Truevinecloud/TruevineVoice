'use client';

/**
 * Invitation acceptance.
 *
 * Requires a session: the token proves the invitation, and the session says who
 * is accepting it. A visitor with a valid link but no account is told to sign in
 * or create one through the normal route rather than being offered a shortcut,
 * because there is no public sign-up.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function AcceptInvitationForm({ token }: { readonly token: string }): React.JSX.Element {
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept(): Promise<void> {
    setError(null);
    setBusy(true);

    try {
      await ensureCsrfToken();
      const result = await request<{ organizationId: string }>('/invitations/accept', {
        method: 'POST',
        body: { token },
      });

      router.replace(`/app?organization=${encodeURIComponent(result.organizationId)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <div>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <button type="button" className="button-primary" onClick={accept} disabled={busy}>
        {busy ? 'Joining...' : 'Accept invitation'}
      </button>
    </div>
  );
}
