'use client';

/**
 * Starts a password reset from the account screen.
 *
 * Reuses the same endpoint as the forgotten-password form. There is no
 * "current password" field here: asking for it proves nothing once a session
 * cookie is stolen, and the reset flow revokes every other session, which is the
 * control that actually matters.
 */

import { useState } from 'react';

import { ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function PasswordResetPrompt(): React.JSX.Element {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    // The account screen already knows who the caller is, so the address does not
    // need to be typed. A reset for a different address would only be another
    // account's problem.
    setBusy(true);
    setError(null);

    try {
      await ensureCsrfToken();
      await request('/auth/password-reset/request', { method: 'POST', body: { email: '' } });
      setSent(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
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
      {sent && (
        <p className="notice notice-success" role="status">
          If that address has an account, a reset link has been sent. Using it signs out every other
          session.
        </p>
      )}

      <p>
        Changing your password signs out every other device. Use the forgot-password flow to receive
        a link.
      </p>

      <button
        type="button"
        className="button-secondary"
        onClick={start}
        disabled={busy || sent}
        style={{ marginTop: '0.5rem' }}
      >
        {busy ? 'Sending...' : 'Email me a reset link'}
      </button>
    </div>
  );
}
