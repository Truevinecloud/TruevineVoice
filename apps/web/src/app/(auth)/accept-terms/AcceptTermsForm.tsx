'use client';

/**
 * Records acceptance of the current terms version.
 *
 * The version string comes from the API's `GET /me`, not from a constant here, so
 * that publishing new terms invalidates a previous acceptance server-side. The
 * server enforces it too: `OrganizationGuard` refuses organization routes until
 * the current version is accepted. This screen is the honest way through that,
 * not the only one.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function AcceptTermsForm({ version }: { readonly version: string }): React.JSX.Element {
  const router = useRouter();

  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept(): Promise<void> {
    setError(null);
    setBusy(true);

    try {
      await ensureCsrfToken();
      await request('/auth/terms/accept', { method: 'POST' });
      router.replace('/app');
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

      <div className="notice notice-info">
        <p style={{ margin: 0 }}>
          You must accept version <strong>{version}</strong> of the terms before you can use the
          application.
        </p>
      </div>

      <div className="notice notice-error">
        <strong>Not yet published.</strong> The terms document itself has not been written. This
        screen records acceptance of a version number with no text behind it. That is a known gap,
        tracked in ADR 0009, and no commercial terms are being agreed to by clicking the box below.
      </div>

      <div className="field">
        <label htmlFor="agree" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <input
            id="agree"
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            style={{ width: 'auto', marginTop: '0.2rem' }}
          />
          <span>I accept version {version} of the terms.</span>
        </label>
      </div>

      <button type="button" className="button-primary" onClick={accept} disabled={busy || !agreed}>
        {busy ? 'Saving...' : 'Accept and continue'}
      </button>
    </div>
  );
}
