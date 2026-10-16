'use client';

/**
 * Membership mutations: remove a member, transfer ownership.
 *
 * Both confirm before acting, because both are irreversible from this screen.
 * Ownership transfer in particular cannot be undone here - the previous owner
 * becomes an admin, and reversing it means another transfer.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function RemoveMemberButton({
  organizationId,
  userId,
  email,
}: {
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
}): React.JSX.Element {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    if (!confirm(`Remove ${email} from this organization?\n\nThey lose access immediately.`)) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await ensureCsrfToken();
      await request(`/organizations/${organizationId}/members/${userId}`, { method: 'DELETE' });
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
        style={{ marginLeft: '0.4rem', fontSize: '0.82rem', padding: '0.3rem 0.6rem' }}
        onClick={remove}
        disabled={busy}
      >
        {busy ? 'Removing...' : 'Remove'}
      </button>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function TransferOwnershipButton({
  organizationId,
  userId,
  email,
}: {
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
}): React.JSX.Element {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transfer(): Promise<void> {
    if (
      !confirm(
        `Make ${email} the owner of this organization?\n\nYou will become an admin. This cannot be undone from here.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await ensureCsrfToken();
      await request(`/organizations/${organizationId}/ownership/transfer`, {
        method: 'POST',
        body: { newOwnerId: userId },
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
        className="button-secondary"
        style={{ fontSize: '0.82rem', padding: '0.3rem 0.6rem' }}
        onClick={transfer}
        disabled={busy}
      >
        {busy ? 'Transferring...' : 'Make owner'}
      </button>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
