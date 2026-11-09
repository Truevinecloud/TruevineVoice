'use client';

import { useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import {
  AccessNotice,
  SupportHeader,
  SupportNav,
  Status,
} from '../support-ui';

type DiagnosticsOverview = {
  organizationCount: number;
  userCount: number;
  activeSupportSessions: number;
  recentDiagnostics: Array<{
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    status: string;
    memberCount: number;
    campaignCount: number;
    walletBalances: Array<{ currency: string; amountMinor: string }>;
    billingProfilePresent: boolean;
    lastChecked: string;
  }>;
};

export default function SupportDiagnosticsPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<DiagnosticsOverview | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api<DiagnosticsOverview>('/platform/support/diagnostics/overview');
          setOverview(result);
          setAccess(null);
        } catch (error) {
          const status = (error as { status?: number }).status ?? 500;
          setAccess(status);
          if (status !== 401 && status !== 403) {
            setMessage('Unable to load diagnostics overview. Please try again.');
          }
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function retry() {
    setMessage('');
    void (async () => {
      try {
        const result = await api<DiagnosticsOverview>('/platform/support/diagnostics/overview');
        setOverview(result);
      } catch {
        setMessage('Unable to load diagnostics overview. Please try again.');
      }
    })();
  }

  if (access === 'checking') {
    return (
      <main className="operations-shell">
        <SupportHeader title="Diagnostics" />
        <SupportNav current="diagnostics" />
        <section className="card" aria-busy="true" aria-label="Loading diagnostics overview">
          <div className="skeleton-kv-grid" style={{ marginBottom: '1rem' }} />
          <div className="skeleton-table" style={{ minHeight: '300px' }} />
        </section>
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title="Diagnostics" />
      <SupportNav current="diagnostics" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {message && (
        <div className="notice" role="alert">
          {message}
          <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {access === null && overview && (
        <>
          <div className="kv-grid" aria-label="Diagnostics workspace summary">
            <div className="kv">
              <span>Organizations</span>
              <strong>{overview.organizationCount}</strong>
            </div>
            <div className="kv">
              <span>Users</span>
              <strong>{overview.userCount}</strong>
            </div>
            <div className="kv">
              <span>Active support sessions</span>
              <strong>{overview.activeSupportSessions}</strong>
            </div>
            <div className="kv">
              <span>Recently checked</span>
              <strong>{overview.recentDiagnostics.length}</strong>
            </div>
          </div>

          <section className="card">
            <div className="section-heading">
              <h2>Recent diagnostics snapshots</h2>
              <span>Organizations with recent support diagnostics access</span>
            </div>
            {overview.recentDiagnostics.length === 0 ? (
              <p className="footnote">No recent diagnostics data available.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Organization</th>
                      <th>Status</th>
                      <th>Members</th>
                      <th>Campaigns</th>
                      <th>Wallet balances</th>
                      <th>Billing profile</th>
                      <th>Last checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recentDiagnostics.map((org) => (
                      <tr key={org.organizationId}>
                        <td>
                          <strong>{org.organizationName}</strong>
                          <small>{org.organizationSlug}</small>
                        </td>
                        <td>
                          <Status value={org.status} />
                        </td>
                        <td>{org.memberCount}</td>
                        <td>{org.campaignCount}</td>
                        <td>
                          {org.walletBalances.length > 0 ? (
                            org.walletBalances.map((b) => (
                              <span key={b.currency} style={{ display: 'inline-block', marginRight: '0.5rem' }}>
                                {b.currency} {b.amountMinor}
                              </span>
                            ))
                          ) : (
                            <span className="footnote">—</span>
                          )}
                        </td>
                        <td>{org.billingProfilePresent ? 'Yes' : 'No'}</td>
                        <td>{org.lastChecked}</td>
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