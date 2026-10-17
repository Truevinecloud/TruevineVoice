import { WEB_APP_INFO } from '../lib/app-info';
import { BrandLogo } from './marketing/BrandLogo';
import { HeroShowcase } from './marketing/HeroShowcase';
import { MarketingHeader } from './marketing/MarketingHeader';

/**
 * Public marketing homepage (TV-WEB-001).
 *
 * The live public surface for voice.truevinecloud.online. Marketing copy only:
 * there is still no public sign-up and no demo-booking flow, so those calls to
 * action are disabled placeholders rather than links to routes that do not
 * exist. Sign In points at the real `/sign-in` route.
 *
 * Capability wording (networks, local-language voice, AI) describes product
 * plans. The footer says so plainly so nothing on this page reads as a claim
 * that those integrations are live in production. All campaign figures in the
 * hero illustration are illustrative sample data.
 */

const BENEFITS = [
  {
    title: 'Works with supported Uganda networks',
    body: 'Built for the networks your customers already use.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" focusable="false">
        <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11.3 21 3 12.7 3 2.5 3 1.9 3.4 1.5 4 1.5h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .7-.2 1L6.6 10.8z" />
      </svg>
    ),
  },
  {
    title: 'Local language voice and AI capabilities',
    body: 'Reach customers in the languages they speak every day.',
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
      </svg>
    ),
  },
  {
    title: 'Easy setup, powerful results',
    body: 'Launch a voice campaign without call centre staff.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" focusable="false">
        <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z" />
      </svg>
    ),
  },
] as const;

const SOLUTIONS = [
  {
    title: 'Payment reminders',
    body: 'Remind customers about dues and upcoming payments with automated calls at the right time.',
  },
  {
    title: 'Announcements',
    body: 'Broadcast service updates, closures and announcements to many contacts at once.',
  },
  {
    title: 'Customer updates',
    body: 'Send delivery, appointment and account updates without manual dialling.',
  },
] as const;

export default function HomePage(): React.JSX.Element {
  return (
    <div className="mk-page">
      <MarketingHeader />

      <main className="mk-main">
        <section className="mk-hero" aria-labelledby="mk-hero-heading">
          <div className="mk-hero-copy">
            <p className="mk-eyebrow">Automated voice engagement for Uganda</p>
            <h1 id="mk-hero-heading">
              Reach thousands with <span className="mk-gold">automated voice calls</span>.
            </h1>
            <p className="mk-hero-sub">
              Send reminders, announcements and customer updates — in local languages — without call
              centre staff.
            </p>

            <div className="mk-cta-row">
              <button
                type="button"
                className="mk-btn mk-btn-gold"
                disabled
                title="Self-serve sign-up is coming soon"
              >
                Start Free Trial
              </button>
              <button
                type="button"
                className="mk-btn mk-btn-outline"
                disabled
                title="Demo scheduling is coming soon"
              >
                Book a Demo
              </button>
            </div>
            <p className="mk-cta-note">
              Self-serve sign-up and demo booking are opening soon. Existing customers can{' '}
              <a href="/sign-in">sign in</a>.
            </p>

            <ul className="mk-benefits" id="product">
              {BENEFITS.map((benefit) => (
                <li key={benefit.title} className="mk-benefit">
                  <span className="mk-benefit-icon" aria-hidden="true">
                    {benefit.icon}
                  </span>
                  <span>
                    <strong className="mk-benefit-title">{benefit.title}</strong>
                    <span className="mk-benefit-body">{benefit.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mk-hero-visual">
            <HeroShowcase />
            <p className="mk-showcase-caption">
              Illustrative sample data — not real customer figures.
            </p>
          </div>
        </section>

        <section id="solutions" className="mk-band" aria-labelledby="mk-solutions-heading">
          <div className="mk-band-inner">
            <h2 id="mk-solutions-heading">Everyday outreach, automated</h2>
            <p className="mk-band-sub">One platform for the messages you already make by phone.</p>
            <div className="mk-cards">
              {SOLUTIONS.map((solution) => (
                <div key={solution.title} className="mk-card">
                  <h3>{solution.title}</h3>
                  <p>{solution.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="mk-footer">
        <div className="mk-footer-inner">
          <div className="mk-footer-brand">
            <BrandLogo className="mk-footer-mark" />
            <span>
              Truevine <span className="mk-brand-voice">Voice</span>
            </span>
          </div>
          <p className="mk-footer-note">
            {WEB_APP_INFO.product} is in development. Carrier integrations, local-language voices
            and AI capabilities described on this page are product plans and are not yet available
            as live production features. All campaign figures shown are illustrative sample data.
          </p>
          <p className="mk-footer-copy">© 2026 Truevine Cloud. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
