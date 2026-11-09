'use client';

import { useEffect, useState, useRef, useCallback, type FormEvent, type ChangeEvent } from 'react';

import { api } from '../../../lib/api';
import {
  AccessNotice,
  SupportHeader,
  SupportNav,
  UsersTable,
  type UserRow,
} from '../support-ui';

type UserSearch = {
  users: UserRow[];
  nextCursor: string | null;
};

/** User lookup (RBAC-009). The server requires at least three characters. */
export default function SupportUsersPage() {
  const [access, setAccess] = useState<number | null | 'checking'>('checking');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<UserRow[]>([]);
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
      void api('/platform/support/me')
        .then(() => setAccess(null))
        .catch((error: { status?: number }) => setAccess(error.status ?? 500))
        .finally(() => {
          if (mountedRef.current) {
            setInitialLoad(false);
          }
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function search(nextCursor?: string, isNewSearch = false) {
    const searchQuery = query.trim();
    if (isNewSearch && searchQuery.length < 3) {
      setMessage('Enter at least 3 characters to search users.');
      return;
    }
    if (isNewSearch) {
      setHasSearched(true);
      setUsers([]);
      setCursor(null);
    }
    const currentRequestId = ++requestIdRef.current;
    setBusy(true);
    setMessage('');
    try {
      const parameters = new URLSearchParams({ q: searchQuery });
      if (nextCursor) parameters.set('cursor', nextCursor);
      const result = await api<UserSearch>(`/platform/support/users?${parameters.toString()}`);
      if (!mountedRef.current || currentRequestId !== requestIdRef.current) {
        return;
      }
      setUsers((current) => (nextCursor ? [...current, ...result.users] : result.users));
      setCursor(result.nextCursor);
    } catch (error) {
      if (!mountedRef.current || currentRequestId !== requestIdRef.current) {
        return;
      }
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 400) {
        setMessage('Enter at least 3 characters, without wildcard characters.');
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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    search(undefined, true);
  }

  function clearQuery() {
    setQuery('');
    setHasSearched(false);
    setUsers([]);
    setCursor(null);
    setMessage('');
  }

  function retry() {
    search(undefined, hasSearched);
  }

  if (access === 'checking' || initialLoad) {
    return (
      <main className="operations-shell">
        <SupportHeader title="Support users" />
        <SupportNav current="users" />
        <section className="card" aria-busy="true" aria-label="Loading users">
          <div className="skeleton-search-bar" style={{ marginBottom: '1.25rem' }} />
          <div className="skeleton-table" style={{ minHeight: '200px' }} />
        </section>
      </main>
    );
  }

  return (
    <main className="operations-shell">
      <SupportHeader title="Support users" />
      <SupportNav current="users" />
      <AccessNotice status={typeof access === 'number' ? access : null} />
      {access === null && (
        <>
          <form className="search-bar" onSubmit={onSubmit}>
            <label>
              Email
              <input
                type="email"
                value={query}
                onChange={onQueryChange}
                placeholder="alice@example.com"
                maxLength={200}
                aria-describedby="user-search-hint"
                disabled={busy}
              />
            </label>
            <button disabled={busy} type="submit">
              {busy ? 'Searching…' : 'Search'}
            </button>
            {query && (
              <button type="button" className="quiet-button" onClick={clearQuery} disabled={busy}>
                Clear
              </button>
            )}
          </form>
          <p id="user-search-hint" className="footnote" style={{ marginBottom: '0.75rem' }}>
            Search by email address. Minimum 3 characters.
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
              <h2>Users</h2>
              <span>{hasSearched ? `${users.length} shown` : 'Enter at least 3 characters to search'}</span>
            </div>
            {users.length === 0 && !busy && hasSearched ? (
              <p className="footnote">No users matched your search.</p>
            ) : (
              <>
                {busy && users.length === 0 && (
                  <div className="skeleton-table" style={{ minHeight: '150px' }} aria-busy="true" />
                )}
                <UsersTable users={users} />
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