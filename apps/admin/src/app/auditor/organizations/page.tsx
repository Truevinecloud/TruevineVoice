'use client';

import { useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import {
  AuditorAccessNotice,
  AuditorHeader,
  AuditorNav,
  OrganizationsTable,
  type OrganizationRow,
} from '../auditor-ui';

type OrganizationsResponse = { organizations: OrganizationRow[]; nextCursor: string | null };

/** Organization identity and status (RBAC-011). Never content, money or members' identities. */
export default function AuditorOrganizationsPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/audit/me');
          setAccess(null);
          await load();
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function load(after?: string) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<OrganizationsResponse>(
        `/platform/audit/organizations${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      );
      setOrganizations((current) => (after ? [...current, ...result.organizations] : result.organizations));
      setCursor(result.nextCursor);
    } catch {
      setMessage('The organization list could not be read.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="operations-shell">
      <AuditorHeader title="Organizations" />
      <AuditorNav current="organizations" />
      <AuditorAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
          <section className="card">
            <div className="section-heading">
              <h2>Organizations</h2>
              <span>{organizations.length} shown</span>
            </div>
            <OrganizationsTable organizations={organizations} />
            {cursor && (
              <button className="quiet-button" disabled={busy} onClick={() => void load(cursor)}>
                Load more
              </button>
            )}
          </section>
          <p className="footnote">
            Identity and status only. Campaign content, wallet balances, billing profiles and
            member lists belong to support diagnostics, which this role does not hold.
          </p>
        </>
      )}
    </main>
  );
}
