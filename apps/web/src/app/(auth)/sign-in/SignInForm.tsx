'use client';

/**
 * Sign-in form.
 *
 * A client component because it must read the CSRF cookie and echo it in a
 * header, which is only possible in the browser. The session token is never
 * touched here: the API sets it as an HTTP-only cookie and this component never
 * sees it.
 */

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function SignInForm(): React.JSX.Element {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      // The API issues the CSRF cookie from any request. Without it the first
      // mutation of a session - the sign-in itself - could not be protected.
      await ensureCsrfToken();

      await request('/auth/sign-in', { method: 'POST', body: { email, password } });

      // Refresh so the server components read the newly issued session cookie.
      router.replace('/app');
      router.refresh();
    } catch (caught) {
      // Deliberately the API's own message. It never says whether the address
      // exists, so there is nothing safer to write here.
      setError(caught instanceof ApiError ? caught.message : messageFor(caught));
      setBusy(false);
    }
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
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <button type="submit" className="button-primary" disabled={busy}>
        {busy ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
