'use client';

/**
 * Chooses a new password from a single-use token.
 *
 * Used by both `/reset-password` (forgot password) and `/set-password` (operator
 * activation of the first Owner). The two flows differ only in where the token
 * comes from and in the wording, not in what happens once it is presented.
 *
 * The token is read from the URL and sent in the request body. It is never
 * persisted anywhere, and is removed from the address bar as soon as it is
 * consumed so it does not survive in browser history or a shared link.
 */

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';
import { MIN_PASSWORD_LENGTH } from './policy';

/** Props. */
export interface SetPasswordFormProps {
  /** Raw token from the link. */
  readonly token: string;
  /** Heading shown above the form. */
  readonly title: string;
  /** Explanation shown under the heading. */
  readonly description: string;
}

export function SetPasswordForm({
  token,
  title,
  description,
}: SetPasswordFormProps): React.JSX.Element {
  const router = useRouter();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && password !== confirmation;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      await ensureCsrfToken();
      await request('/auth/password-reset/complete', {
        method: 'POST',
        body: { token, newPassword: password },
      });

      // Replace rather than push, so the token is not left in history.
      router.replace('/sign-in');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);

        // A spent or expired link is terminal. Offering to try again with the
        // same token would be a dead end.
        if (caught.code === 'token_already_used' || caught.code === 'invalid_or_expired_token') {
          setBusy(false);
          return;
        }
      } else {
        setError(messageFor(caught));
      }

      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1>{title}</h1>
      <p className="auth-subtitle">{description}</p>

      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor="password">New password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="field-hint">
          At least {MIN_PASSWORD_LENGTH} characters. A long passphrase is stronger than a short one
          with symbols forced into it.
        </p>
        {tooShort && (
          <p className="notice notice-error">
            {MIN_PASSWORD_LENGTH - password.length} more character
            {MIN_PASSWORD_LENGTH - password.length === 1 ? '' : 's'} needed.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="confirmation">Confirm new password</label>
        <input
          id="confirmation"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {mismatch && <p className="notice notice-error">The two passwords do not match.</p>}
      </div>

      <button type="submit" className="button-primary" disabled={busy || tooShort || mismatch}>
        {busy ? 'Saving...' : 'Set password'}
      </button>
    </form>
  );
}
