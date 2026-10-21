'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../../../lib/api';
import {
  AuditorAccessNotice,
  AuditorAuditTable,
  AuditorHeader,
  AuditorNav,
  type AuditEventRow,
} from '../auditor-ui';

type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };

/** Platform audit trail (RBAC-011): operator actions across the platform, newest first. */
export default function AuditorAuditPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [action, setAction] = useState('');
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(nextCursor?: string) {
    setBusy(true);
    setMessage('');
    try {
      const parameters = new URLSearchParams();
      if (action.trim()) parameters.set('action', action.trim());
      if (nextCursor) parameters.set('cursor', nextCursor);
      const result = await api<AuditTrail>(
        `/platform/audit/audit${parameters.size > 0 ? `?${parameters.toString()}` : ''}`,
      );
      setEvents((current) => (nextCursor ? [...current, ...result.events] : result.events));
      setCursor(result.nextCursor);
    } catch {
      setMessage('That filter is not valid, or the trail could not be read.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load();
  }

  return (
    <main className="operations-shell">
      <AuditorHeader title="Audit trail" />
      <AuditorNav current="audit" />
      <AuditorAccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          <form className="search-bar" onSubmit={onSubmit}>
            <label>
              Action
              <input
                value={action}
                onChange={(event) => setAction(event.target.value)}
                placeholder="platform.audit.overview_viewed"
                maxLength={64}
              />
            </label>
            <button disabled={busy} type="submit">
              Filter
            </button>
          </form>
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
          <section className="card">
            <div className="section-heading">
              <h2>Platform audit trail</h2>
              <span>{events.length} shown</span>
            </div>
            <AuditorAuditTable events={events} />
            {cursor && (
              <button className="quiet-button" disabled={busy} onClick={() => void load(cursor)}>
                Load more
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
