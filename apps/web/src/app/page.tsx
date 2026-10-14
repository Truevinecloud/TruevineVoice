import { WEB_APP_INFO } from '../lib/app-info';

/**
 * Customer web application.
 *
 * This page is the live public web surface for Truevine Voice. The deployment
 * target is voice.truevinecloud.online, served by this Next.js application
 * behind Nginx on port 3000.
 *
 * Honest scope: the site is live and the platform is reachable, but the voice
 * product itself is not built yet. Calling, contacts, campaigns and billing are
 * still absent. This page says so rather than implying a working dialler.
 */
export default function HomePage() {
  return (
    <main>
      <span className="badge">Live</span>
      <h1>{WEB_APP_INFO.product}</h1>
      <p className="subtitle">
        {WEB_APP_INFO.surface} for Truevine Voice is live, running on {WEB_APP_INFO.framework}.
      </p>

      <section className="card">
        <h2>Live web for voice</h2>
        <p>
          This site is live at <code>voice.truevinecloud.online</code>. It is the public web surface
          for the Truevine Voice platform, built for outbound voice engagement in Uganda.
        </p>
        <ul>
          <li>The web application is deployed and serving traffic.</li>
          <li>The REST API is live and reports infrastructure health at GET /health.</li>
          <li>The background worker is running and connected to Redis.</li>
        </ul>
      </section>

      <section className="card roadmap" aria-labelledby="roadmap-heading">
        <span className="badge">Coming next</span>
        <h2 id="roadmap-heading">Built for customer conversations in Uganda</h2>
        <p>
          We are laying the groundwork for outbound voice engagement. Voice calling and campaign
          tools are planned and are not available yet.
        </p>
        <p>
          The platform is live; the voice product is still under construction. Making outbound
          calls, managing contacts and campaigns, and billing are the next pieces of work.
        </p>
        <p>
          Our focus: clear communication, reliable delivery and an experience that is easy to use.
        </p>
      </section>
    </main>
  );
}
