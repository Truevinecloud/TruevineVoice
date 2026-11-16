'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, api } from '../../../lib/api';
import {
  AuditorAccessNotice, AuditorAuditTable, AuditorHeader, AuditorNav, type AuditEventRow,
} from '../auditor-ui';

type AuditTrail = { events: AuditEventRow[]; nextCursor: string | null };

type Filters = {
  action: string;
  trail: string;
  outcome: string;
  actor: string;
  organizationId: string;
  targetId: string;
  from: string;
  to: string;
};

const NO_FILTERS: Filters = {
  action: '',
  trail: '',
  outcome: '',
  actor: '',
  organizationId: '',
  targetId: '',
  from: '',
  to: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the API's documented limits so obvious mistakes are explained next to
 * the field instead of becoming a 400 after a round trip. The API still
 * validates everything: this is convenience, not the authority.
 */
function validate(filters: Filters): string | null {
  const actor = filters.actor.trim();
  if (actor.length > 200 || /[\\%_]/.test(actor)) {
    return 'Actor search must be up to 200 characters without wildcards.';
  }
  if (filters.organizationId.trim() && !UUID.test(filters.organizationId.trim())) {
    return 'Organization ID must be a full UUID.';
  }
  if (
    filters.targetId.trim() &&
    !/^[A-Za-z0-9:_-]{1,64}$/.test(filters.targetId.trim())
  ) {
    return 'Target ID must be 1–64 characters using letters, digits, colon, underscore or dash.';
  }
  if (
    (filters.from.trim() && Number.isNaN(Date.parse(filters.from))) ||
    (filters.to.trim() && Number.isNaN(Date.parse(filters.to)))
  ) {
    return 'Enter valid dates for the time range.';
  }
  if (filters.from.trim() && filters.to.trim() && filters.from > filters.to) {
    return 'The start date must not be after the end date.';
  }
  return null;
}

export default function AuditorAuditPage() {
  const filterHintId = useId();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [cursor, setCursor] = useState('');
  // Retrying identical filters must still issue a request; the revision is what
  // distinguishes "same query, try again" from "nothing changed".
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<AuditTrail | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setStatus(null);
      setProblem(null);
      if (!cursor) setResult(null);
      void (async () => {
        try {
          await api('/platform/audit/me', { signal: controller.signal });
          const parameters = new URLSearchParams();
          for (const [key, value] of Object.entries(applied)) {
            if (value.trim()) parameters.set(key, value.trim());
          }
          if (cursor) parameters.set('cursor', cursor);
          const page = await api<AuditTrail>(
            `/platform/audit/audit${parameters.size ? `?${parameters}` : ''}`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) {
            setResult((previous) => ({
              events: cursor ? [...(previous?.events ?? []), ...page.events] : page.events,
              nextCursor: page.nextCursor,
            }));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            const code = error instanceof ApiError ? error.status : 500;
            setStatus(code);
            setProblem(error instanceof ApiError && error.detail ? error.detail : null);
            if (code === 401 || code === 403) setResult(null);
          }
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [applied, cursor, revision]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = validate(draft);
    setValidation(message);
    if (message) return;
    setBusy(true);
    setCursor('');
    setApplied({ ...draft });
    setRevision((value) => value + 1);
  }

  function clearFilters() {
    setDraft({ ...NO_FILTERS });
    setApplied({ ...NO_FILTERS });
    setCursor('');
    setValidation(null);
    setRevision((value) => value + 1);
  }

  function retry() {
    setBusy(true);
    setRevision((value) => value + 1);
  }

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidation(null);
  }

  const denied = status === 401 || status === 403;
  const activeFilters = Object.entries(applied).filter(([, value]) => value.trim());
  return (
    <div className="operations-shell auditor-workspace">
      <AuditorHeader title="Sensitive Action Audit" />
      <AuditorNav current="audit" />
      <p className="subtitle">Review recorded platform actions, actors, targets, and outcomes. Records are read-only, newest first, with times shown in UTC.</p>
      <AuditorAccessNotice status={denied ? status : null} />
      {!denied && (
        <>
          <form className="search-bar audit-filters" onSubmit={onSubmit} aria-describedby={filterHintId}>
            <label>Exact action
              <input value={draft.action} onChange={(event) => update('action', event.target.value)}
                placeholder="platform.audit.overview_viewed" maxLength={64} />
            </label>
            <label>Trail
              <select value={draft.trail} onChange={(event) => update('trail', event.target.value)}>
                <option value="">Both trails</option>
                <option value="identity">Identity</option>
                <option value="security">Security</option>
              </select>
            </label>
            <label>Outcome
              <select value={draft.outcome} onChange={(event) => update('outcome', event.target.value)}>
                <option value="">Any outcome</option>
                <option value="SUCCESS">Success</option>
                <option value="DENIED">Denied</option>
              </select>
            </label>
            <label>Actor email or ID
              <input value={draft.actor} onChange={(event) => update('actor', event.target.value)}
                placeholder="operator@example.com" maxLength={200} />
            </label>
            <label>Organization ID
              <input value={draft.organizationId}
                onChange={(event) => update('organizationId', event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
            </label>
            <label>Target ID
              <input value={draft.targetId} onChange={(event) => update('targetId', event.target.value)}
                placeholder="wallet_entry:…" maxLength={64} />
            </label>
            <label>From (UTC)
              <input type="date" value={draft.from} onChange={(event) => update('from', event.target.value)} />
            </label>
            <label>To (UTC)
              <input type="date" value={draft.to} onChange={(event) => update('to', event.target.value)} />
            </label>
            <div className="button-row">
              <button disabled={busy} type="submit">{busy ? 'Filtering…' : 'Apply filters'}</button>
              <button type="button" className="quiet-button" onClick={clearFilters}
                disabled={busy || activeFilters.length === 0}>
                Clear filters
              </button>
            </div>
            <p className="footnote audit-filter-hint" id={filterHintId}>
              Filters combine. Leave a field empty to ignore it; dates are UTC calendar days.
            </p>
          </form>
          {validation && (
            <p className="notice form-error" role="alert">{validation}</p>
          )}
          {status !== null && !denied && (
            <div className="notice" role="alert">
              <p>
                {problem ??
                  (status === 400
                    ? 'One of the filters is not valid. Check the values and try again.'
                    : status === 429
                      ? 'Too many requests. Wait a moment, then retry.'
                      : 'Audit records are temporarily unavailable.')}
              </p>
              <button className="quiet-button" disabled={busy} onClick={retry}>Retry</button>
            </div>
          )}
          <section className="card" aria-busy={busy}>
            <div className="section-heading">
              <h2>Platform audit trail</h2>
              <span>{result?.events.length ?? 0} shown</span>
            </div>
            {activeFilters.length > 0 && (
              <ul className="audit-active-filters" aria-label="Applied filters">
                {activeFilters.map(([key, value]) => (
                  <li key={key}><span>{key}</span> {value}</li>
                ))}
              </ul>
            )}
            {busy && <p role="status">Loading audit events...</p>}
            {!busy && status !== null && !result && (
              <p className="footnote">Audit records are not shown while the request is failing.</p>
            )}
            {result && <AuditorAuditTable events={result.events} />}
            {result?.nextCursor && (
              <button className="quiet-button" disabled={busy} onClick={() => {
                setBusy(true);
                setCursor(result.nextCursor!);
              }}>Load more</button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
