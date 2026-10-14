import { WEB_APP_INFO } from '../lib/app-info';

/**
 * Foundation placeholder.
 *
 * Proves the customer web application builds and serves. Product functionality
 * (authentication, contacts, campaigns, voice, wallet, billing) is deliberately
 * absent at this stage.
 */
export default function HomePage() {
  return (
    <main>
      <span className="badge">Foundation</span>
      <h1>{WEB_APP_INFO.product}</h1>
      <p className="subtitle">
        {WEB_APP_INFO.surface} is running on {WEB_APP_INFO.framework}.
      </p>

      <section className="card">
        <h2>Engineering foundation only</h2>
        <p>
          This page exists to prove the application starts, builds and renders. No product
          functionality has been implemented yet.
        </p>
        <ul>
          <li>Outbound Voice for Uganda is the first planned channel.</li>
          <li>The REST API is served separately by the NestJS API app.</li>
          <li>
            Infrastructure health is available at <code>GET /health</code> on the API.
          </li>
        </ul>
      </section>

      <section className="card roadmap" aria-labelledby="roadmap-heading">
        <span className="badge">Coming next</span>
        <h2 id="roadmap-heading">Built for customer conversations in Uganda</h2>
        <p>
          We are laying the groundwork for outbound voice engagement. Voice calling and
          campaign tools are planned and are not available yet.
        </p>
        <p>Our focus: clear communication, reliable delivery and an experience that is easy to use.</p>
      </section>
    </main>
  );
}
