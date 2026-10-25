'use client';

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="card-section page-error" role="alert">
      <h1>Workspace unavailable</h1>
      <p>We could not load this page. Your account and saved data are unchanged.</p>
      <button type="button" className="button-primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
