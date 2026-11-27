'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Client-side compatibility redirect.
 *
 * Server-side `redirect()` double-prefixes the admin `basePath` in this app, so
 * route aliases use the client router to preserve the configured `/admin` prefix.
 */
export function RouteAlias({ href, label }: { href: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return (
    <main className="operations-shell">
      <p role="status">Redirecting to {label}…</p>
    </main>
  );
}
