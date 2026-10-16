import { AcceptTermsForm } from './AcceptTermsForm';

/** `/accept-terms` */
export default function AcceptTermsPage(): React.JSX.Element {
  return (
    <main className="auth-shell">
      <h1>Accept the terms</h1>
      <p className="auth-subtitle">One step before you can use Truevine Voice.</p>

      {/* The version is resolved server-side in the dashboard guard, which
          redirects here. This screen renders whatever version it is given. */}
      <AcceptTermsForm version="2026-10-01" />
    </main>
  );
}
