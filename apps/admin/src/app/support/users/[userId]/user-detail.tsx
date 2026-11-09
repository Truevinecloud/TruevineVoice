'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';

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
  const [auditError, setAuditError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const detailRequestIdRef = useRef(0);
  const auditRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    const currentRequestId = ++detailRequestIdRef.current;
    try {
      await api('/platform/support/me');
      const result = await api<UserDetail>(`/platform/support/users/${userId}`);
      if (!mountedRef.current || currentRequestId !== detailRequestIdRef.current) {
        return;
      }
      setDetail(result);
      setAccess(null);
    } catch (error) {
      if (!mountedRef.current || currentRequestId !== detailRequestIdRef.current) {
        return;
      }
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 401) setAccess(401);
      else if (statusCode === 403) setAccess(403);
      else if (statusCode === 404) setAccess(404);
      else setAccess(statusCode ?? 500);
    } finally {
      if (mountedRef.current && currentRequestId === detailRequestIdRef.current) {
        setLoadingDetail(false);
      }
    }
  }, [userId]);

  const loadAudit = useCallback(async () => {
    setLoadingAudit(true);
    setAuditError(null);
    const currentRequestId = ++auditRequestIdRef.current;
    try {
      const result = await api<AuditTrail>(`/platform/support/users/${userId}/audit`);
      if (!mountedRef.current || currentRequestId !== auditRequestIdRef.current) {
        return;
      }
      setAudit(result.events);
    } catch (error) {
      if (!mountedRef.current || currentRequestId !== auditRequestIdRef.current) {
        return;
      }
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 404) {
        setAuditError('User not found.');
      } else {
        setAuditError('Audit trail is unavailable. Please try again.');
      }
    } finally {
      if (mountedRef.current && currentRequestId === auditRequestIdRef.current) {
        setLoadingAudit(false);
      }
    }
  }, [userId]);

  useEffect(() => {
    mountedRef.current = true;
    window.setTimeout(() => loadDetail(), 0);
    return () => {
      mountedRef.current = false;
    };
  }, [loadDetail]);

  function retryAudit() {
    setAudit(null);
    loadAudit();
  }

  if (access === 'checking' || loadingDetail) {
    return (
      <main className="operations-shell">
        <SupportHeader title="User" />
        <SupportNav current="users" />
        <section className="card" aria-busy="true" aria-label="Loading user details">
          <div className="skeleton-kv-grid" style={{ marginBottom: '1rem' }}>
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
            <div className="skeleton-kv" />
          </div>
          <div className="skeleton-table" style={{ minHeight: '150px' }} />
        </section>
      </main>
    );
  }

  if (access === 404) {
    return (
      <main className="operations-shell">
        <SupportHeader title="User not found" />
        <SupportNav current="users" />
        <AccessNotice status={404} />
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title={detail?.user.email ?? 'User'} />
      <SupportNav current="users" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
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
                          <Link href={`/support/customers/${membership.organizationId}`}>
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
              ) : loadingAudit ? (
                <span>Loading…</span>
              ) : auditError ? (
                <span>Error loading audit trail</span>
              ) : (
                <span>Newest first</span>
              )}
            </div>
            {audit !== null && !loadingAudit && <AuditTable events={audit} />}
            {loadingAudit && <div className="skeleton-table" style={{ minHeight: '200px' }} aria-busy="true" />}
            {auditError && (
              <div className="notice" role="alert" style={{ marginTop: '1rem' }}>
                {auditError}
                <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retryAudit}>
                  Retry
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}