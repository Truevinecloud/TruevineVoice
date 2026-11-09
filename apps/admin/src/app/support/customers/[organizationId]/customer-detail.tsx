'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

import { api } from '../../../../lib/api';
import {
  AccessNotice,
  AuditTable,
  DiagnosticsPanels,
  MembersTable,
  Status,
  SupportHeader,
  SupportNav,
  type AuditEventRow,
  type DiagnosticsView,
  type MemberRow,
} from '../../support-ui';

type OrganizationDetail = {
  organization: {
    id: string;
    name: string;
    slug: string;
    status: 'ACTIVE' | 'SUSPENDED';
    createdAt: string;
    updatedAt: string;
    suspendedAt: string | null;
    memberCount: number;
    campaignCount: number;
  };
  members: MemberRow[];
  memberCount: number;
};

type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };

type Tab = 'overview' | 'diagnostics' | 'audit';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'audit', label: 'Audit' },
];

/**
 * Customer organization detail (RBAC-009).
 *
 * Diagnostics sit behind a stronger permission than the overview, so a denied
 * diagnostics tab is shown as unavailable rather than hidden: the operator can
 * tell the difference between "no data" and "not permitted".
 */
export default function CustomerDetail({ organizationId }: { organizationId: string }) {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsView | null>(null);
  const [audit, setAudit] = useState<AuditEventRow[]>([]);
  const [diagnosticsDenied, setDiagnosticsDenied] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const detailRequestIdRef = useRef(0);
  const diagnosticsRequestIdRef = useRef(0);
  const auditRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    const currentRequestId = ++detailRequestIdRef.current;
    try {
      await api('/platform/support/me');
      const result = await api<OrganizationDetail>(
        `/platform/support/organizations/${organizationId}`,
      );
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
  }, [organizationId]);

  const loadDiagnostics = useCallback(async () => {
    setLoadingDiagnostics(true);
    setDiagnosticsDenied(false);
    setDiagnosticsError(null);
    const currentRequestId = ++diagnosticsRequestIdRef.current;
    try {
      const result = await api<DiagnosticsView>(
        `/platform/support/organizations/${organizationId}/diagnostics`,
      );
      if (!mountedRef.current || currentRequestId !== diagnosticsRequestIdRef.current) {
        return;
      }
      setDiagnostics(result);
    } catch (error) {
      if (!mountedRef.current || currentRequestId !== diagnosticsRequestIdRef.current) {
        return;
      }
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 403) {
        setDiagnosticsDenied(true);
      } else if (statusCode === 404) {
        setDiagnosticsError('Organization not found.');
      } else {
        setDiagnosticsError('Diagnostics are unavailable. Please try again.');
      }
    } finally {
      if (mountedRef.current && currentRequestId === diagnosticsRequestIdRef.current) {
        setLoadingDiagnostics(false);
      }
    }
  }, [organizationId]);

  const loadAudit = useCallback(async () => {
    setLoadingAudit(true);
    setAuditError(null);
    const currentRequestId = ++auditRequestIdRef.current;
    try {
      const result = await api<AuditTrail>(
        `/platform/support/organizations/${organizationId}/audit`,
      );
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
        setAuditError('Organization not found.');
      } else {
        setAuditError('Audit trail is unavailable. Please try again.');
      }
    } finally {
      if (mountedRef.current && currentRequestId === auditRequestIdRef.current) {
        setLoadingAudit(false);
      }
    }
  }, [organizationId]);

  useEffect(() => {
    mountedRef.current = true;
    window.setTimeout(() => loadDetail(), 0);
    return () => {
      mountedRef.current = false;
    };
  }, [loadDetail]);

  useEffect(() => {
    if (tab === 'diagnostics' && !diagnostics && !diagnosticsDenied && !loadingDiagnostics) {
      window.setTimeout(() => loadDiagnostics(), 0);
    }
    if (tab === 'audit' && audit.length === 0 && !loadingAudit) {
      window.setTimeout(() => loadAudit(), 0);
    }
  }, [tab, loadDiagnostics, loadAudit, diagnostics, diagnosticsDenied, audit.length, loadingDiagnostics, loadingAudit]);

  function retryDiagnostics() {
    setDiagnostics(null);
    setDiagnosticsDenied(false);
    loadDiagnostics();
  }

  function retryAudit() {
    setAudit([]);
    loadAudit();
  }

  if (access === 'checking' || loadingDetail) {
    return (
      <main className="operations-shell">
        <SupportHeader title="Organization" />
        <SupportNav current="customers" />
        <section className="card" aria-busy="true" aria-label="Loading organization details">
          <div className="skeleton-kv-grid" style={{ marginBottom: '1rem' }}>
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
        <SupportHeader title="Organization not found" />
        <SupportNav current="customers" />
        <AccessNotice status={404} />
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title={detail?.organization.name ?? 'Organization'} />
      <SupportNav current="customers" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && detail && (
        <>
          <div className="tabs" role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                className={tab === entry.id ? 'tab tab-active' : 'tab'}
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {tab === 'overview' && (
            <>
              <div className="kv-grid" aria-label="Organization summary">
                <div className="kv">
                  <span>Slug</span>
                  <strong>{detail.organization.slug}</strong>
                </div>
                <div className="kv">
                  <span>Status</span>
                  <Status value={detail.organization.status} />
                </div>
                <div className="kv">
                  <span>Members</span>
                  <strong>{detail.organization.memberCount}</strong>
                </div>
                <div className="kv">
                  <span>Campaigns</span>
                  <strong>{detail.organization.campaignCount}</strong>
                </div>
                <div className="kv">
                  <span>Created</span>
                  <strong>{detail.organization.createdAt}</strong>
                </div>
                <div className="kv">
                  <span>Suspended</span>
                  <strong>{detail.organization.suspendedAt ?? '—'}</strong>
                </div>
              </div>
              <section className="card">
                <div className="section-heading">
                  <h2>Members</h2>
                  <span>{detail.memberCount} shown</span>
                </div>
                <MembersTable members={detail.members} />
              </section>
            </>
          )}
          {tab === 'diagnostics' && (
            <>
              {diagnosticsDenied ? (
                <div className="notice" role="status">
                  You do not have permission to view diagnostics for this organization.
                </div>
              ) : loadingDiagnostics ? (
                <section className="card" aria-busy="true" aria-label="Loading diagnostics">
                  <div className="skeleton-kv-grid" style={{ marginBottom: '1rem' }}>
                    <div className="skeleton-kv" />
                    <div className="skeleton-kv" />
                    <div className="skeleton-kv" />
                    <div className="skeleton-kv" />
                    <div className="skeleton-kv" />
                    <div className="skeleton-kv" />
                  </div>
                  <div className="skeleton-table" style={{ minHeight: '200px' }} />
                  <div className="skeleton-table" style={{ minHeight: '150px', marginTop: '1rem' }} />
                  <div className="skeleton-table" style={{ minHeight: '150px', marginTop: '1rem' }} />
                  <div className="skeleton-table" style={{ minHeight: '150px', marginTop: '1rem' }} />
                </section>
              ) : diagnostics ? (
                <DiagnosticsPanels diagnostics={diagnostics} />
              ) : diagnosticsError ? (
                <div className="notice" role="alert">
                  {diagnosticsError}
                  <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retryDiagnostics}>
                    Retry
                  </button>
                </div>
              ) : (
                <div className="notice" role="status">
                  Diagnostics could not be loaded.
                  <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retryDiagnostics}>
                    Retry
                  </button>
                </div>
              )}
            </>
          )}
          {tab === 'audit' && (
            <section className="card">
              <div className="section-heading">
                <h2>Audit trail</h2>
                <span>Newest first</span>
              </div>
              {loadingAudit ? (
                <div className="skeleton-table" style={{ minHeight: '200px' }} aria-busy="true" />
              ) : auditError ? (
                <>
                  <AuditTable events={audit} />
                  <div className="notice" role="alert" style={{ marginTop: '1rem' }}>
                    {auditError}
                    <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retryAudit}>
                      Retry
                    </button>
                  </div>
                </>
              ) : (
                <AuditTable events={audit} />
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}