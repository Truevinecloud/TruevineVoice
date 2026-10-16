'use client';

/**
 * Organization profile form.
 *
 * `slug` is not editable here, deliberately: it is the stable public identifier,
 * and changing it breaks customer bookmarks and any provider reference captured
 * against it. Showing it read-only with an explanation is better than showing an
 * input that silently does nothing.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../lib/api';

export function OrganizationSettingsForm({
  organizationId,
  slug,
  name,
}: {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
}): React.JSX.Element {
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaved(false);
    setError(null);

    const trimmed = value.trim();

    if (trimmed.length === 0 || trimmed.length > 200) {
      setError('The organization name must be between 1 and 200 characters.');
      return;
    }

    setBusy(true);

    try {
      await ensureCsrfToken();
      await request(`/organizations/${organizationId}`, {
        method: 'PATCH',
        body: { name: trimmed },
      });

      setValue(trimmed);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : messageFor(caught));
    } finally {
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
      {saved && (
        <p className="notice notice-success" role="status">
          Organization name updated.
        </p>
      )}

      <div className="field">
        <label htmlFor="name">Organization name</label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={200}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="slug">Organization identifier</label>
        <input id="slug" name="slug" type="text" value={slug} readOnly disabled />
        <p className="field-hint">
          Permanent. This appears in integrations and cannot be changed, because changing it breaks
          existing references.
        </p>
      </div>

      <button type="submit" className="button-primary" style={{ width: 'auto' }} disabled={busy}>
        {busy ? 'Saving...' : 'Save changes'}
      </button>
    </form>
  );
}
