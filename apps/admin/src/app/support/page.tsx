'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { api } from '../../lib/api';
import {
  AccessNotice,
  SupportHeader,
  SupportNav,
  Status,
  type SupportOperator,
} from './support-ui';

type OverviewStats = {
  organizationCount: number;
  userCount: number;
  activeSupportSessions: number;
};

type RecentAuditEvent = {
  id: string;
  action: string;
  outcome: string;
  occurredAt: string;
  actor: { userId: string; email: string };
  targetType: string | null;
  targetId: string | null;
};

type OverviewResponse = {
  operator: SupportOperator;
  stats: OverviewStats;
  recentActivity: RecentAuditEvent[];
};

export default function SupportOverviewPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api<OverviewResponse>('/platform/support/overview');
          setOverview(result);
          setAccess(null);
        } catch (error) {
          const status = (error as { status?: number }).status ?? 500;
          setAccess(status);
          if (status !== 401 && status !== 403) {
            setMessage('Unable to load support overview. Please try again.');
          }
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (access === 'checking') {
    return (
      <main className="operations-shell">
        <SupportHeader title="Support" />
        <SupportNav current="overview" />
        <div className="card" aria-busy="true">
          <p className="footnote">Loading support overview…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title="Support" />
      <SupportNav current="overview" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {message && <p className="notice" role="alert">{message}</p>}
      {access === null && overview && (
        <>
          <div className="kv-grid" aria-label="Support workspace summary">
            <div className="kv">
              <span>Your role</span>
              <strong>{overview.operator.platformRole ?? 'Unknown'}</strong>
            </div>
            <div className="kv">
              <span>Organizations</span>
              <strong>{overview.stats.organizationCount}</strong>
            </div>
            <div className="kv">
              <span>Users</span>
              <strong>{overview.stats.userCount}</strong>
            </div>
            <div className="kv">
              <span>Active support sessions</span>
              <strong>{overview.stats.activeSupportSessions}</strong>
            </div>
          </div>

          <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))', gap: '1rem' }}>
            <Link href="/support" className="nav-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>Customers</h3>
              <p style={{ margin: 0, color: 'var(--muted-fg)', fontSize: '0.85rem' }}>
                Search and view organization details, members, diagnostics, and audit trails
              </p>
            </Link>
            <Link href="/support/users" className="nav-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>Users</h3>
              <p style={{ margin: 0, color: 'var(--muted-fg)', fontSize: '0.85rem' }}>
                Look up accounts by email, view memberships, sessions, and account audit trails
              </p>
            </Link>
            <Link href="/support/diagnostics" className="nav-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>Diagnostics</h3>
              <p style={{ margin: 0, color: 'var(--muted-fg)', fontSize: '0.85rem' }}>
                System health signals, configuration status, and operational warnings
              </p>
            </Link>
          </div>

          <section className="card">
            <div className="section-heading">
              <h2>Recent support activity</h2>
              <span>Newest first · Platform-wide</span>
            </div>
            {overview.recentActivity.length === 0 ? (
              <p className="footnote">No recent support activity recorded.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Outcome</th>
                      <th>Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recentActivity.map((event) => (
                      <tr key={event.id}>
                        <td>{event.occurredAt}</td>
                        <td>
                          <strong>{event.action}</strong>
                        </td>
                        <td>
                          {event.actor.email}
                          <small>{event.actor.userId}</small>
                        </td>
                        <td>
                          <Status value={event.outcome} />
                        </td>
                        <td>
                          {event.targetType && event.targetId && (
                            <small>{`${event.targetType} ${event.targetId}`}</small>
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