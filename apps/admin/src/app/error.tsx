'use client';

export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="operations-shell">
      <section className="card" role="alert">
        <h1>Platform page unavailable</h1>
        <p>We could not load this page. Your account and data are unchanged.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
