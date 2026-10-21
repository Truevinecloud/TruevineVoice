'use client';

import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { AuditorAccessNotice, AuditorHeader, AuditorNav, OverviewPanels, type OverviewView } from './auditor-ui';

/**
 * Auditor overview (RBAC-011): how much of the platform there is to account
 * for, and what this role can and cannot reach.
 */
export default function AuditorOverviewPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<OverviewView | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/audit/me');
          const result = await api<OverviewView>('/platform/audit/overview');
          setOverview(result);
          setAccess(null);
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="operations-shell">
      <AuditorHeader title="Audit" />
      <AuditorNav current="overview" />
      <AuditorAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && overview && (
        <section className="card">
          <div className="section-heading">
            <h2>Overview</h2>
          </div>
          <OverviewPanels overview={overview} />
        </section>
      )}
    </main>
  );
}
