'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { api, ApiError } from '../../lib/api';

type Assignment = {
  userId: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  role: string;
  grantedByUserId: string | null;
  grantedAt: string;
  revokedAt: string | null;
};

type UserOption = {
  id: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  platformRole: string | null;
};

const PLATFORM_ROLES = [
  { value: 'PLATFORM_OWNER', label: 'Platform Owner', description: 'Full platform administration and role management.' },
  { value: 'OPERATIONS_ADMIN', label: 'Operations Admin', description: 'Tenant and campaign operations.' },
  { value: 'BILLING_ADMIN', label: 'Billing Admin', description: 'Billing and refund operations.' },
  { value: 'SUPPORT_ADMIN', label: 'Support Admin', description: 'Customer support and diagnostics.' },
  { value: 'TECHNICAL_ADMIN', label: 'Technical Admin', description: 'Technical diagnostics and audit reads.' },
  { value: 'AUDITOR', label: 'Auditor', description: 'Read-only platform audit access.' },
] as const;

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function PlatformAdminPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<UserOption[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [role, setRole] = useState<string>(PLATFORM_ROLES[0].value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const activeOwnerCount = assignments.filter((item) => item.role === 'PLATFORM_OWNER' && item.revokedAt === null).length;

  async function load() {
    setLoading(true);
    setError('');
    try {
      await api('/platform/admin/me');
      const rows = await api<Assignment[]>('/platform/admin/roles');
      setAssignments(rows);
      setAccess(null);
    } catch (caught) {
      const status = caught instanceof ApiError ? caught.status : 500;
      setAccess(status);
      if (status === 401) setError('Sign in with a platform Super Admin account.');
      else if (status === 403) setError('Platform admin role management is available to the platform Super Admin only.');
      else setError('Platform admin data is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function searchUsers(value: string) {
    setQuery(value);
    setSelectedUser(null);
    if (value.trim().length < 3) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError('');
    try {
      const rows = await api<UserOption[]>(`/platform/admin/users?query=${encodeURIComponent(value.trim())}`);
      setResults(rows);
    } catch (caught) {
      const status = caught instanceof ApiError ? caught.status : 0;
      setError(status ? `User search failed (${status}).` : 'User search failed.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!selectedUser) {
      setError('Select an eligible user before granting a role.');
      return;
    }
    if (!window.confirm(`Grant ${role} to ${selectedUser.email}?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/platform/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ userId: selectedUser.id, role }),
      });
      setMessage(`Granted ${role} to ${selectedUser.email}.`);
      setSelectedUser(null);
      setQuery('');
      setResults([]);
      await load();
    } catch {
      setError('Role grant failed. Check the user and your permissions.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(assignment: Assignment) {
    if (!window.confirm(`Revoke platform role from ${assignment.email}?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/platform/admin/roles/${assignment.userId}/revoke`, { method: 'POST' });
      setMessage(`Revoked platform role from ${assignment.email}.`);
      await load();
    } catch {
      setError('Role revocation failed. The last active platform owner cannot be removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="operations-shell platform-admin-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">TRUEVINE VOICE · PLATFORM ADMINISTRATION</span>
          <h1>Platform administrators</h1>
          <p className="subtitle">Manage platform operator roles securely. Only active users without an existing platform role are eligible.</p>
        </div>
      </header>

      {error && <p className="notice form-error" role="alert">{error}</p>}
      {message && <p className="notice form-success" role="status">{message}</p>}

      {access !== null && loading && <p className="notice" role="status">Checking access…</p>}

      {access === null && (
        <>
          <section className="card">
            <h2>Grant platform role</h2>
            <form onSubmit={grant} className="credential-form">
              <label>
                Search eligible users
                <input
                  aria-label="Search eligible users"
                  value={query}
                  onChange={(event) => void searchUsers(event.target.value)}
                  placeholder="Enter at least 3 characters of an email"
                  disabled={busy}
                />
              </label>
              {searching && <p className="footnote">Searching…</p>}
              {results.length > 0 && (
                <div className="table-wrap" role="listbox" aria-label="Eligible users">
                  {results.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className="quiet-button"
                      style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '.35rem' }}
                      onClick={() => {
                        setSelectedUser(user);
                        setQuery(user.email);
                        setResults([]);
                      }}
                    >
                      {user.email} <small>({user.status.toLowerCase()})</small>
                    </button>
                  ))}
                </div>
              )}
              {selectedUser && (
                <p className="footnote">Selected: {selectedUser.email}</p>
              )}
              <label>
                Platform role
                <select aria-label="Platform role" value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
                  {PLATFORM_ROLES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="footnote">{PLATFORM_ROLES.find((item) => item.value === role)?.description}</p>
              <div className="button-row">
                <button type="submit" disabled={busy || !selectedUser}>
                  {busy ? 'Saving…' : 'Grant role'}
                </button>
              </div>
            </form>
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Current assignments</h2>
              <span>{assignments.length} shown</span>
            </div>
            {loading ? (
              <p>Loading assignments…</p>
            ) : assignments.length === 0 ? (
              <p>No platform role assignments.</p>
            ) : (
              <div className="table-wrap">
                <table className="platform-admin-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Assignment</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignments.map((assignment) => (
                      <tr key={assignment.userId}>
                        <td data-label="User" className="email-cell">
                          {assignment.email}
                          <details className="footnote">
                            <summary>Technical details</summary>
                            <small>{assignment.userId}</small>
                          </details>
                        </td>
                        <td data-label="Role">{PLATFORM_ROLES.find((item) => item.value === assignment.role)?.label ?? assignment.role}</td>
                        <td data-label="Status">
                          <span className={`status ${assignment.revokedAt ? 'status-suspended' : 'status-active'}`}>
                            {assignment.revokedAt ? 'Revoked' : 'Active'}
                          </span>
                          <small>{assignment.status}</small>
                        </td>
                        <td data-label="Assignment">
                          <small>Granted {formatDate(assignment.grantedAt)}</small>
                          {assignment.revokedAt && <small>Revoked {formatDate(assignment.revokedAt)}</small>}
                        </td>
                        <td data-label="Actions">
                          {assignment.revokedAt === null ? (
                            assignment.role === 'PLATFORM_OWNER' && activeOwnerCount <= 1 ? (
                              <span className="status status-suspended">Protected</span>
                            ) : (
                              <button
                                type="button"
                                className="danger-button platform-admin-action"
                                disabled={busy}
                                onClick={() => void revoke(assignment)}
                              >
                                Revoke
                              </button>
                            )
                          ) : (
                            <span className="footnote">No action</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
