'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { api } from '../../../../lib/api';
import {
  AccessNotice,
  AuditTable,
  Status,
  SupportHeader,
  SupportNav,
  type AuditEventRow,
} from '../../support-ui';

type UserDetail = {
  user: {
    id: string;
    email: string;
    status: 'ACTIVE' | 'SUSPENDED';
    createdAt: string;
    updatedAt: string;
    lockedUntil: string | null;
    failedLoginCount: number;
    passwordChangedAt: string;
    platformRole: { role: string; grantedAt: string } | null;
    membershipCount: number;
  };
  memberships: Array<{
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: string;
    joinedAt: string;
  }>;
  sessionSummary: {
    active: number;
    revoked: number;
    expired: number;
    lastUsedAt: string | null;
  };
};

type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };

/**
 * User detail (RBAC-009).
 *
 * Read-only. Where the account is a member of an organization, the link jumps
 * to that organization's support page; no membership data is copied here.
 */
export default function UserDetail({ userId }: { userId: string }) {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [audit, setAudit] = useState<AuditEventRow[] | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/support/me');
          const result = await api<UserDetail>(`/platform/support/users/${userId}`);
          setDetail(result);
          setAccess(null);
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [userId]);

  async function loadAudit() {
    try {
      const result = await api<AuditTrail>(`/platform/support/users/${userId}/audit`);
      setAudit(result.events);
    } catch {
      setMessage('Audit trail is unavailable.');
    }
  }

  return (
    <main className="operations-shell">
      <SupportHeader title={detail?.user.email ?? 'User'} />
      <SupportNav current="users" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {message && <p className="notice">{message}</p>}
      {access === null && detail && (
        <>
          <div className="kv-grid" aria-label="User summary">
            <div className="kv">
              <span>Status</span>
              <Status value={detail.user.status} />
            </div>
            <div className="kv">
              <span>Platform role</span>
              <strong>{detail.user.platformRole?.role ?? '—'}</strong>
            </div>
            <div className="kv">
              <span>Organizations</span>
              <strong>{detail.user.membershipCount}</strong>
            </div>
            <div className="kv">
              <span>Failed sign-ins</span>
              <strong>{detail.user.failedLoginCount}</strong>
            </div>
            <div className="kv">
              <span>Password changed</span>
              <strong>{detail.user.passwordChangedAt}</strong>
            </div>
            <div className="kv">
              <span>Locked until</span>
              <strong>{detail.user.lockedUntil ?? '—'}</strong>
            </div>
            <div className="kv">
              <span>Active sessions</span>
              <strong>{detail.sessionSummary.active}</strong>
            </div>
            <div className="kv">
              <span>Last session used</span>
              <strong>{detail.sessionSummary.lastUsedAt ?? '—'}</strong>
            </div>
          </div>
          <section className="card">
            <div className="section-heading">
              <h2>Organizations</h2>
              <span>{detail.memberships.length} shown</span>
            </div>
            {detail.memberships.length === 0 ? (
              <p>This account belongs to no organization.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Organization</th>
                      <th>Role</th>
                      <th>Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.memberships.map((membership) => (
                      <tr key={membership.organizationId}>
                        <td>
                          <Link
                            href={`/support/customers/${membership.organizationId}`}
                          >
                            <strong>{membership.organizationName}</strong>
                            <small>{membership.organizationSlug}</small>
                          </Link>
                        </td>
                        <td>{membership.role}</td>
                        <td>{membership.joinedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="card">
            <div className="section-heading">
              <h2>Account audit trail</h2>
              {audit === null ? (
                <button className="quiet-button" onClick={() => void loadAudit()}>
                  Load trail
                </button>
              ) : (
                <span>Newest first</span>
              )}
            </div>
            {audit !== null && <AuditTable events={audit} />}
          </section>
        </>
      )}
    </main>
  );
}
