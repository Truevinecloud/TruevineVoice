'use client';

import { useEffect, useState, useRef, useCallback, type FormEvent, type ChangeEvent } from 'react';

import { api } from '../../../lib/api';
import {
  AccessNotice,
  OrganizationsTable,
  SupportHeader,
  SupportNav,
  type OrganizationRow,
} from '../support-ui';

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
  const [initialLoad, setInitialLoad] = useState(true);
  const [hasSearched, setHasSearched] = useState(false);

  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const debouncedSearch = useCallback((fn: () => void) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(fn, 300);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await api('/platform/support/me');
          setAccess(null);
          await search();
        } catch (error) {
          setAccess((error as { status?: number }).status ?? 500);
        } finally {
          if (mountedRef.current) {
            setInitialLoad(false);
          }
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(nextCursor?: string, isNewSearch = false) {
    if (isNewSearch) {
      setHasSearched(true);
      setOrganizations([]);
      setCursor(null);
    }
    const currentRequestId = ++requestIdRef.current;
    setBusy(true);
    setMessage('');
    try {
      const parameters = new URLSearchParams();
      const searchQuery = query.trim();
      if (searchQuery) parameters.set('q', searchQuery);
      if (status) parameters.set('status', status);
      if (nextCursor) parameters.set('cursor', nextCursor);
      const result = await api<OrganizationSearch>(
        `/platform/support/organizations${parameters.size > 0 ? `?${parameters.toString()}` : ''}`,
      );
      if (!mountedRef.current || currentRequestId !== requestIdRef.current) {
        return;
      }
      setOrganizations((current) => (nextCursor ? [...current, ...result.organizations] : result.organizations));
      setCursor(result.nextCursor);
    } catch (error) {
      if (!mountedRef.current || currentRequestId !== requestIdRef.current) {
        return;
      }
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 400) {
        setMessage('Invalid search parameters. Please check your input and try again.');
      } else if (statusCode === 401) {
        setAccess(401);
      } else if (statusCode === 403) {
        setAccess(403);
      } else {
        setMessage('Search failed. Please try again.');
      }
    } finally {
      if (mountedRef.current && currentRequestId === requestIdRef.current) {
        setBusy(false);
        setInitialLoad(false);
      }
    }
  }

  function onQueryChange(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
    debouncedSearch(() => search(undefined, true));
  }

  function onStatusChange(event: ChangeEvent<HTMLSelectElement>) {
    setStatus(event.target.value);
    search(undefined, true);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    search(undefined, true);
  }

  function clearFilters() {
    setQuery('');
    setStatus('');
    search(undefined, true);
  }

  function retry() {
    search(undefined, hasSearched);
  }

  const hasFilters = query.trim() !== '' || status !== '';

  if (access === 'checking' || initialLoad) {
    return (
      <main className="operations-shell">
        <SupportHeader title="Customers" />
        <SupportNav current="customers" />
        <section className="card" aria-busy="true" aria-label="Loading organizations">
          <div className="skeleton-search-bar" style={{ marginBottom: '1.25rem' }} />
          <div className="skeleton-table" style={{ minHeight: '200px' }} />
        </section>
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title="Customers" />
      <SupportNav current="customers" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          <form className="search-bar" onSubmit={onSubmit}>
            <label>
              Name or slug
              <input
                value={query}
                onChange={onQueryChange}
                placeholder="acme"
                maxLength={200}
                aria-describedby="search-hint"
                disabled={busy}
              />
            </label>
            <label>
              Status
              <select value={status} onChange={onStatusChange} disabled={busy}>
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </label>
            <button disabled={busy} type="submit">
              {busy ? 'Searching…' : 'Search'}
            </button>
            {hasFilters && (
              <button type="button" className="quiet-button" onClick={clearFilters} disabled={busy}>
                Clear filters
              </button>
            )}
          </form>
          <p id="search-hint" className="footnote" style={{ marginBottom: '0.75rem' }}>
            Search by organization name or slug. Minimum 1 character.
          </p>
          {message && (
            <div className="notice" role="alert">
              {message}
              <button type="button" className="quiet-button" style={{ marginLeft: '0.75rem' }} onClick={retry}>
                Retry
              </button>
            </div>
          )}
          <section className="card">
            <div className="section-heading">
              <h2>Organizations</h2>
              <span>{hasSearched || query || status ? `${organizations.length} shown` : 'Enter search criteria to begin'}</span>
            </div>
            {organizations.length === 0 && !busy && (hasSearched || query || status) ? (
              <p className="footnote">No organizations matched your criteria.</p>
            ) : (
              <>
                {busy && organizations.length === 0 && (
                  <div className="skeleton-table" style={{ minHeight: '150px' }} aria-busy="true" />
                )}
                <OrganizationsTable organizations={organizations} />
                {cursor && (
                  <button className="quiet-button" disabled={busy} onClick={() => void search(cursor)}>
                    {busy ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}