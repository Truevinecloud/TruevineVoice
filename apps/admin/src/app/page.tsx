import { ADMIN_APP_INFO } from '../lib/app-info';

/**
 * Foundation placeholder.
 *
 * Proves the separate platform-admin frontend starts, builds and renders. No
 * admin functionality (operator authentication, tenant management, support
 * tooling) is implemented at this stage.
 */
export default function AdminHomePage() {
  return (
    <main>
      <span className="badge">Foundation</span>
      <h1>{ADMIN_APP_INFO.product} Admin</h1>
      <p className="subtitle">{ADMIN_APP_INFO.surface}</p>

      <section className="card">
        <h2>No admin functionality yet</h2>
        <p>
          Intended audience: {ADMIN_APP_INFO.audience}. This page exists only to prove the
          application builds and serves. Operator authentication, tenant management and every other
          admin capability is deferred to a later step.
        </p>
      </section>
    </main>
  );
}
