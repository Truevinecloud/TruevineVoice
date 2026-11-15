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
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setAccess('checking');
      void (async () => {
        try {
          await api('/platform/audit/me', { signal: controller.signal });
          const result = await api<OverviewView>('/platform/audit/overview', { signal: controller.signal });
          if (controller.signal.aborted) return;
          setOverview(result);
          setAccess(null);
        } catch (error) {
          if (controller.signal.aborted) return;
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [revision]);

  return (
    <div className="operations-shell auditor-workspace">
      <AuditorHeader title="Audit" />
      <AuditorNav current="overview" />
      {access === 'checking' && <p role="status">Loading audit overview…</p>}
      <AuditorAccessNotice status={typeof access === 'number' ? access : null} />
      {typeof access === 'number' && access !== 401 && access !== 403 && (
        <button className="quiet-button" onClick={() => setRevision((value) => value + 1)}>Retry</button>
      )}
      {access === null && overview && (
        <section className="card">
          <div className="section-heading">
            <h2>Overview</h2>
          </div>
          <OverviewPanels overview={overview} />
        </section>
      )}
    </div>
  );
}
