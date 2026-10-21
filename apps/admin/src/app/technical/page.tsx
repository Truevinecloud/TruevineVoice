'use client';

import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { OverviewPanels, TechnicalAccessNotice, TechnicalHeader, TechnicalNav, type OverviewView } from './technical-ui';

/**
 * Technical overview (RBAC-010).
 *
 * Probes the API's own health view; every subsystem the platform cannot report
 * on is rendered with the reason, never as an empty section.
 */
export default function TechnicalOverviewPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [overview, setOverview] = useState<OverviewView | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/technical/me');
          const result = await api<OverviewView>('/platform/technical/overview');
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
      <TechnicalHeader title="Technical" />
      <TechnicalNav current="overview" />
      <TechnicalAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && overview && (
        <section className="card">
          <div className="section-heading">
            <h2>Overview</h2>
            <span>{overview.application.timestamp}</span>
          </div>
          <OverviewPanels overview={overview} />
        </section>
      )}
    </main>
  );
}
