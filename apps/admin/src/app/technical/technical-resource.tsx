'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { TechnicalAccessNotice, TechnicalHeader, TechnicalNav } from './technical-ui';

/** Cancellation prevents stale responses when navigating or refreshing. */
export function TechnicalResource<T>({
  title,
  section,
  endpoint,
  children,
}: {
  title: string;
  section: 'overview' | 'providers' | 'queues' | 'logs';
  endpoint: string;
  children: (data: T) => ReactNode;
}) {
  const [result, setResult] = useState<{ data: T } | { status: number } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<T>(endpoint, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({ status: (error as { status?: number }).status ?? 503 });
      },
    );
    return () => controller.abort();
  }, [endpoint, revision]);

  function refresh() {
    setResult(null);
    setRevision((value) => value + 1);
  }
  return (
    <main className="operations-shell technical-workspace">
      <TechnicalHeader title={title} />
      <TechnicalNav current={section} />
      <p className="footnote">
        Read-only technical access. Financial administration and platform-role changes are
        unavailable to Technical Admin.
      </p>
      {result === null ? (
        <p role="status" aria-live="polite">
          Loading {title.toLowerCase()}…
        </p>
      ) : 'status' in result ? (
        <>
          <TechnicalAccessNotice status={result.status} />
          {result.status !== 401 && result.status !== 403 && (
            <button onClick={refresh}>Retry</button>
          )}
        </>
      ) : (
        <>
          <div className="section-heading">
            <span>Live response from the API</span>
            <button className="quiet-button" onClick={refresh}>
              Refresh
            </button>
          </div>
          {children(result.data)}
        </>
      )}
    </main>
  );
}
