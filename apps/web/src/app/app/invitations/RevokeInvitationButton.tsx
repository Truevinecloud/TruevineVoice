'use client';

/** Revokes an outstanding invitation. */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function RevokeInvitationButton({
  organizationId,
  invitationId,
  email,
}: {
  readonly organizationId: string;
  readonly invitationId: string;
  readonly email: string;
}): React.JSX.Element {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(): Promise<void> {
    if (!confirm(`Revoke the invitation for ${email}? The link will stop working.`)) return;

    setBusy(true);
    setError(null);

    try {
      await ensureCsrfToken();
      await request(`/organizations/${organizationId}/invitations/${invitationId}`, {
        method: 'DELETE',
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button-secondary button-danger"
        style={{ fontSize: '0.82rem', padding: '0.3rem 0.6rem' }}
        onClick={revoke}
        disabled={busy}
      >
        {busy ? 'Revoking...' : 'Revoke'}
      </button>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
