'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../../lib/api';
import {
  TechnicalAccessNotice,
  TechnicalAuditTable,
  TechnicalHeader,
  TechnicalNav,
  type AuditEventRow,
} from '../technical-ui';
type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };
export default function TechnicalAuditPage() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState({ action: '', cursor: '' });
  const [data, setData] = useState<AuditTrail | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [queryError, setQueryError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams();
    if (query.action) parameters.set('action', query.action);
    if (query.cursor) parameters.set('cursor', query.cursor);
    void api<AuditTrail>(`/platform/technical/audit?${parameters}`, {
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setData((current) => ({
          events: query.cursor ? [...(current?.events ?? []), ...result.events] : result.events,
          nextCursor: result.nextCursor,
        }));
        setBusy(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus((error as { status?: number }).status ?? 503);
        if (error instanceof ApiError) {
          if (error.code === 'technical_audit_scope')
            setQueryError(
              'Only platform-operation events are available. Clear or change the action filter.',
            );
          else if (error.code === 'invalid_action')
            setQueryError(
              'Unknown audit action. Enter a registered platform action or clear the filter.',
            );
          else if (error.code === 'audit_cursor_not_found')
            setQueryError('That audit position is unavailable. Refresh the trail to start again.');
        }
        setBusy(false);
      },
    );
    return () => controller.abort();
  }, [query]);
  function request(action: string, cursor = '') {
    setBusy(true);
    setStatus(null);
    setQueryError('');
    setQuery({ action, cursor });
  }
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setData(null);
    request(draft.trim());
  }
  return (
    <main className="operations-shell technical-workspace">
      <TechnicalHeader title="Technical audit trail" />
      <TechnicalNav current="audit" />
      <p className="footnote">
        Technical Admin sees platform-operation events only. Customer identities and raw metadata
        are withheld.
      </p>
      <form className="search-bar" onSubmit={filter}>
        <label>
          Action
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="platform.technical.overview_viewed"
            maxLength={64}
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy}>
          Filter
        </button>
      </form>
      <button className="quiet-button" disabled={busy} onClick={() => request(query.action)}>
        Refresh
      </button>
      {busy && <p role="status">Loading audit events…</p>}
      {queryError ? <p role="alert">{queryError}</p> : <TechnicalAccessNotice status={status} />}
      {status !== null && status !== 401 && status !== 403 && !queryError && (
        <button onClick={() => request(query.action, query.cursor)}>Retry</button>
      )}
      {queryError && (
        <button
          onClick={() => {
            setDraft('');
            setData(null);
            request('');
          }}
        >
          Clear filter
        </button>
      )}
      {data && status === null && (
        <section className="card" aria-busy={busy}>
          <div className="section-heading">
            <h2>Platform audit trail</h2>
            <span>{data.events.length} shown</span>
          </div>
          <TechnicalAuditTable events={data.events} />
          {data.nextCursor && (
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => request(query.action, data.nextCursor!)}
            >
              Load more
            </button>
          )}
        </section>
      )}
    </main>
  );
}
