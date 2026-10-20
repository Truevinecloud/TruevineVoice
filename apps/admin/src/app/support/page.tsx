'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../../lib/api';
import {
  AccessNotice,
  OrganizationsTable,
  SupportHeader,
  SupportNav,
  type OrganizationRow,
} from './support-ui';

type OrganizationSearch = {
  organizations: OrganizationRow[];
  nextCursor: string | null;
};

/**
 * Customer organization lookup (RBAC-009).
 *
 * The query an operator types is sent to the API and never stored anywhere in
 * this application; the server records the search without the query string.
 */
export default function SupportCustomersPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/support/me');
          setAccess(null);
          await search();
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(nextCursor?: string) {
    setBusy(true);
    setMessage('');
    try {
      const parameters = new URLSearchParams();
      if (query.trim()) parameters.set('q', query.trim());
      if (status) parameters.set('status', status);
      if (nextCursor) parameters.set('cursor', nextCursor);
      const result = await api<OrganizationSearch>(
        `/platform/support/organizations${parameters.size > 0 ? `?${parameters.toString()}` : ''}`,
      );
      setOrganizations((current) => (nextCursor ? [...current, ...result.organizations] : result.organizations));
      setCursor(result.nextCursor);
    } catch {
      setMessage('Search failed. Check the filters and try again.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search();
  }

  return (
    <main className="operations-shell">
      <SupportHeader title="Support" />
      <SupportNav current="customers" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          <form className="search-bar" onSubmit={onSubmit}>
            <label>
              Name or slug
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="acme"
                maxLength={200}
              />
            </label>
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </label>
            <button disabled={busy} type="submit">
              Search
            </button>
          </form>
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
              <button className="quiet-button" disabled={busy} onClick={() => void search(cursor)}>
                Load more
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
