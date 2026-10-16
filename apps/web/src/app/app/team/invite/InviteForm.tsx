'use client';

/**
 * Invitation form.
 *
 * The role list comes from the shared registry via the `delegableRoles` helper,
 * so the options offered here are exactly the roles the server will accept.
 * Offering an owner option would produce a request the server refuses, which is
 * a poor way to teach a user what is possible.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, ensureCsrfToken, messageFor, request } from '../../../../lib/api';

export function InviteForm({
  organizationId,
  organizationName,
  roles,
}: {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly roles: readonly string[];
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[0] ?? 'VIEWER');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (roles.length === 0) {
    return (
      <p className="notice notice-info">
        Your role cannot delegate any roles in this organization. Ask an owner to invite people.
      </p>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSent(null);
    setBusy(true);

    try {
      await ensureCsrfToken();
      await request(`/organizations/${organizationId}/invitations`, {
        method: 'POST',
        body: { email, role },
      });

      // The API deliberately does not return the invitation token: the only copy
      // lives in the emailed link.
      setSent(
        `An invitation was created for ${email}. The link was emailed to them; it can be used once and expires in seven days.`,
      );
      setEmail('');
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
      {sent !== null && (
        <p className="notice notice-success" role="status">
          {sent}
        </p>
      )}

      <div className="field">
        <label htmlFor="invite-email">Email address</label>
        <input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="invite-role">Role</label>
        <select
          id="invite-role"
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {roles.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <p className="field-hint">
          You can only grant roles that hold no more authority than your own. Owner is transferred
          separately and never by invitation.
        </p>
      </div>

      <button type="submit" className="button-primary" style={{ width: 'auto' }} disabled={busy}>
        {busy ? 'Sending...' : `Send invitation to ${organizationName}`}
      </button>
    </form>
  );
}
