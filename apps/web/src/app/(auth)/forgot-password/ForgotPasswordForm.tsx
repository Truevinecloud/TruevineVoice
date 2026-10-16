'use client';

/**
 * Password-reset request form.
 *
 * The response is deliberately identical whether or not the address is
 * registered. This component must not reintroduce the leak the API works to
 * avoid by saying something like "if that account exists...", because that is
 * the same oracle wearing a hat.
 */

import { useState, type FormEvent } from 'react';

import { ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function ForgotPasswordForm(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await ensureCsrfToken();
      await request('/auth/password-reset/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <p className="notice notice-success" role="status">
          If that address has a Truevine Voice account, a reset link is on its way. The link can be
          used once and expires in one hour.
        </p>
        <div className="auth-links">
          <a href="/sign-in">Back to sign in</a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <p className="field-hint">We will send a link that lets you choose a new password.</p>
      </div>

      <button type="submit" className="button-primary" disabled={busy}>
        {busy ? 'Sending...' : 'Send reset link'}
      </button>
    </form>
  );
}
