'use client';

import { useEffect, useState, type FormEvent } from 'react';

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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api('/platform/support/me')
        .then(() => setAccess(null))
        .catch((error: { status?: number }) => setAccess(error.status ?? 500));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function search(nextCursor?: string) {
    const search = query.trim();
    if (search.length < 3) {
      setMessage('Enter at least 3 characters to search users.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const parameters = new URLSearchParams({ q: search });
      if (nextCursor) parameters.set('cursor', nextCursor);
      const result = await api<UserSearch>(`/platform/support/users?${parameters.toString()}`);
      setUsers((current) => (nextCursor ? [...current, ...result.users] : result.users));
      setCursor(result.nextCursor);
    } catch (error) {
      setMessage(
        (error as { status?: number }).status === 400
          ? 'Enter at least 3 characters, without wildcard characters.'
          : 'Search failed. Try again.',
      );
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
                onChange={(event) => setQuery(event.target.value)}
                placeholder="alice@example.com"
                maxLength={200}
              />
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
              <h2>Users</h2>
              <span>{users.length} shown</span>
            </div>
            <UsersTable users={users} />
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
