'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';
import { MIN_PASSWORD_LENGTH } from '../shared/policy';

export function ActivateInvitationForm({ token }: { readonly token: string }): React.JSX.Element {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      setError(`Choose a password between ${MIN_PASSWORD_LENGTH} and 200 characters.`);
      return;
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await ensureCsrfToken();
      await request('/invitations/activate', {
        method: 'POST',
        body: { token, password },
      });
      router.replace('/sign-in?invitation=activated');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="notice notice-info">
        Set a password to activate the account invited to this organization. Your organization and
        role come from the invitation.
      </p>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="activation-password">New password</label>
        <input
          id="activation-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="activation-confirmation">Confirm password</label>
        <input
          id="activation-confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <button type="submit" className="button-primary" disabled={busy}>
        {busy ? 'Activating...' : 'Set password and activate'}
      </button>
    </form>
  );
}
