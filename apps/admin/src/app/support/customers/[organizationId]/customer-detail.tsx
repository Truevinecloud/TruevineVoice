'use client';

import { useEffect, useState } from 'react';

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
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/support/me');
          const result = await api<OrganizationDetail>(
            `/platform/support/organizations/${organizationId}`,
          );
          setDetail(result);
          setAccess(null);
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [organizationId]);

  useEffect(() => {
    if (tab === 'diagnostics' && !diagnostics && !diagnosticsDenied) {
      api<DiagnosticsView>(`/platform/support/organizations/${organizationId}/diagnostics`)
        .then(setDiagnostics)
        .catch((error: { status?: number }) => {
          if (error.status === 403) setDiagnosticsDenied(true);
          else setMessage('Diagnostics are unavailable.');
        });
    }
    if (tab === 'audit' && audit.length === 0) {
      api<AuditTrail>(`/platform/support/organizations/${organizationId}/audit`)
        .then((result) => setAudit(result.events))
        .catch(() => setMessage('Audit trail is unavailable.'));
    }
  }, [tab, organizationId, diagnostics, diagnosticsDenied, audit.length]);

  return (
    <main className="operations-shell">
      <SupportHeader title={detail?.organization.name ?? 'Organization'} />
      <SupportNav current="customers" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {message && <p className="notice">{message}</p>}
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
          {tab === 'diagnostics' &&
            (diagnosticsDenied ? (
              <p className="notice" role="status">
                You do not have permission to view diagnostics for this organization.
              </p>
            ) : diagnostics ? (
              <DiagnosticsPanels diagnostics={diagnostics} />
            ) : (
              <p className="footnote">Loading diagnostics…</p>
            ))}
          {tab === 'audit' && (
            <section className="card">
              <div className="section-heading">
                <h2>Audit trail</h2>
                <span>Newest first</span>
              </div>
              <AuditTable events={audit} />
            </section>
          )}
        </>
      )}
    </main>
  );
}
