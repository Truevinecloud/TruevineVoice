'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { AuditorAccessNotice, AuditorHeader, AuditorNav, OrganizationsTable, type OrganizationRow } from '../auditor-ui';

type OrganizationsResponse = { organizations: OrganizationRow[]; nextCursor: string | null };

/** Organization identity/status only; the API independently checks platform permissions. */
export default function AuditorOrganizationsPage() {
  const [query, setQuery] = useState({ after: '', revision: 0 });
  const [result, setResult] = useState<OrganizationsResponse | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true); setStatus(null);
      void (async () => {
        try {
          await api('/platform/audit/me', { signal: controller.signal });
          const page = await api<OrganizationsResponse>(
            `/platform/audit/organizations${query.after ? `?after=${encodeURIComponent(query.after)}` : ''}`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setResult((previous) => ({
            organizations: query.after ? [...(previous?.organizations ?? []), ...page.organizations] : page.organizations,
            nextCursor: page.nextCursor,
          }));
        } catch (error) {
          if (!controller.signal.aborted) {
            const code = (error as { status?: number }).status ?? 500;
            setStatus(code);
            if (code === 401 || code === 403) setResult(null);
          }
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const denied = status === 401 || status === 403;
  return (
    <div className="operations-shell auditor-workspace">
      <AuditorHeader title="Organizations" />
      <AuditorNav current="organizations" />
      <p className="subtitle">Review organization identity, status and membership counts.</p>
      <AuditorAccessNotice status={denied ? status : null} />
      {!denied && (
        <>
          {status !== null && (
            <div className="notice" role="alert">
              <p>The organization list could not be read. Please retry.</p>
              <button className="quiet-button" disabled={busy} onClick={() => {
                setBusy(true); setQuery((previous) => ({ ...previous, revision: previous.revision + 1 }));
              }}>Retry</button>
            </div>
          )}
          <section className="card" aria-busy={busy}>
            <div className="section-heading"><h2>Organizations</h2><span>{result?.organizations.length ?? 0} shown</span></div>
            {busy && <p role="status">Loading organizations...</p>}
            {result && <OrganizationsTable organizations={result.organizations} />}
            {result?.nextCursor && (
              <button className="quiet-button" disabled={busy} onClick={() => {
                setBusy(true); setQuery((previous) => ({ ...previous, after: result.nextCursor! }));
              }}>Load more</button>
            )}
          </section>
          <p className="footnote">This directory shows organization metadata. Customer content, financial records and member identities require separate permissions.</p>
        </>
      )}
    </div>
  );
}
