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

const PLATFORM_ROLES = [
  'PLATFORM_OWNER',
  'OPERATIONS_ADMIN',
  'BILLING_ADMIN',
  'SUPPORT_ADMIN',
  'TECHNICAL_ADMIN',
  'AUDITOR',
] as const;

export default function PlatformAdminPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<string>(PLATFORM_ROLES[0]);
  const [message, setMessage] = useState('');

  async function load() {
    try {
      await api('/platform/admin/me');
      const rows = await api<Assignment[]>('/platform/admin/roles');
      setAssignments(rows);
      setAccess(null);
      setMessage('');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      setAccess(status);
      if (status === 401) setMessage('Sign in with a platform Super Admin account.');
      else if (status === 403) setMessage('Platform admin role management is available to the platform Super Admin only.');
      else setMessage('Platform admin data is temporarily unavailable.');
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function grant(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    try {
      await api('/platform/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ userId, role }),
      });
      setUserId('');
      await load();
    } catch {
      setMessage('Role grant failed. Check the user id and your permissions.');
    }
  }

  async function revoke(targetUserId: string) {
    setMessage('');
    try {
      await api(`/platform/admin/roles/${targetUserId}/revoke`, { method: 'POST' });
      await load();
    } catch {
      setMessage('Role revocation failed. The last active platform owner cannot be removed.');
    }
  }

  return (
    <main className="operations-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">TRUEVINE VOICE · PLATFORM ADMINISTRATION</span>
          <h1>Platform administrators</h1>
        </div>
      </header>
      {access !== null && <p className="notice" role="status">{message}</p>}
      {access === null && (
        <>
          <section className="card">
            <h2>Grant platform role</h2>
            <form onSubmit={grant} className="form-row">
              <input
                aria-label="User id"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="User UUID"
                required
              />
              <select aria-label="Platform role" value={role} onChange={(e) => setRole(e.target.value)}>
                {PLATFORM_ROLES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <button type="submit">Grant</button>
            </form>
            {message && <p className="notice">{message}</p>}
          </section>
          <section className="card">
            <h2>Current assignments</h2>
            {assignments.length === 0 ? (
              <p>No platform role assignments.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Granted</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((assignment) => (
                    <tr key={assignment.userId}>
                      <td>{assignment.email}</td>
                      <td>{assignment.role}</td>
                      <td>{assignment.status}</td>
                      <td>{assignment.grantedAt}</td>
                      <td>
                        {assignment.revokedAt === null && (
                          <button type="button" onClick={() => void revoke(assignment.userId)}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
