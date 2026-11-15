'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../lib/api';
import {
  AuditorAccessNotice, AuditorAuditTable, AuditorHeader, AuditorNav, type AuditEventRow,
} from '../auditor-ui';

type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };

export default function AuditorAuditPage() {
  const [action, setAction] = useState('');
  const [query, setQuery] = useState({ action: '', cursor: '', revision: 0 });
  const [result, setResult] = useState<AuditTrail | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setStatus(null);
      if (!query.cursor) setResult(null);
      void (async () => {
        try {
          await api('/platform/audit/me', { signal: controller.signal });
          const parameters = new URLSearchParams();
          if (query.action) parameters.set('action', query.action);
          if (query.cursor) parameters.set('cursor', query.cursor);
          const page = await api<AuditTrail>(
            `/platform/audit/audit${parameters.size ? `?${parameters}` : ''}`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) {
            setResult((previous) => ({
              events: query.cursor ? [...(previous?.events ?? []), ...page.events] : page.events,
              nextCursor: page.nextCursor,
            }));
          }
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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setQuery((previous) => ({ action: action.trim(), cursor: '', revision: previous.revision + 1 }));
  }

  const denied = status === 401 || status === 403;
  return (
    <div className="operations-shell auditor-workspace">
      <AuditorHeader title="Audit trail" />
      <AuditorNav current="audit" />
      <p className="subtitle">Review operator activity across the platform. Events appear newest first; all times are UTC.</p>
      <AuditorAccessNotice status={denied ? status : null} />
      {!denied && (
        <>
          <form className="search-bar" onSubmit={onSubmit}>
            <label>Exact action
              <input value={action} onChange={(event) => setAction(event.target.value)}
                placeholder="platform.audit.overview_viewed" maxLength={64} />
            </label>
            <button disabled={busy} type="submit">Filter</button>
          </form>
          {status !== null && (
            <div className="notice" role="alert">
              <p>{status === 400 ? 'Enter a valid, registered audit action.' : status === 429 ? 'Too many requests. Wait a moment, then retry.' : 'Audit records are temporarily unavailable.'}</p>
              <button className="quiet-button" disabled={busy} onClick={() => {
                setBusy(true);
                setQuery((previous) => ({ ...previous, revision: previous.revision + 1 }));
              }}>Retry</button>
            </div>
          )}
          <section className="card" aria-busy={busy}>
            <div className="section-heading"><h2>Platform audit trail</h2><span>{result?.events.length ?? 0} shown</span></div>
            {busy && <p role="status">Loading audit events...</p>}
            {result && <AuditorAuditTable events={result.events} />}
            {result?.nextCursor && (
              <button className="quiet-button" disabled={busy} onClick={() => {
                setBusy(true);
                setQuery((previous) => ({ ...previous, cursor: result.nextCursor! }));
              }}>Load more</button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
