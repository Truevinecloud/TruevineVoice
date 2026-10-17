'use client';

/**
 * Public marketing header (TV-WEB-001).
 *
 * A client component only because the mobile menu needs local open/closed
 * state. Everything else is presentational.
 *
 * Interaction honesty: there is no public sign-up and no demo-booking flow, so
 * "Book a Demo" is a disabled placeholder rather than a link to a route that
 * does not exist. "Sign In" points at the real `/sign-in` route. Product and
 * Solutions scroll to sections on this page; Pricing and Resources are disabled
 * placeholders with a visible "Soon" badge.
 */

import { useState } from 'react';

import { BrandLogo } from './BrandLogo';

type NavItem =
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  | { readonly kind: 'soon'; readonly label: string };

const NAV_ITEMS: readonly NavItem[] = [
  { kind: 'link', href: '#product', label: 'Product' },
  { kind: 'link', href: '#solutions', label: 'Solutions' },
  { kind: 'soon', label: 'Pricing' },
  { kind: 'soon', label: 'Resources' },
];

const DEMO_TITLE = 'Demo scheduling is coming soon';

export function MarketingHeader(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="mk-header">
      <div className="mk-header-inner">
        <a className="mk-brand" href="/">
          <BrandLogo className="mk-brand-mark" />
          <span className="mk-brand-name">
            Truevine <span className="mk-brand-voice">Voice</span>
          </span>
        </a>

        <nav className="mk-nav" aria-label="Main">
          {NAV_ITEMS.map((item) =>
            item.kind === 'link' ? (
              <a key={item.href} className="mk-nav-link" href={item.href}>
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                className="mk-nav-soon"
                disabled
                title={`${item.label} is coming soon`}
              >
                {item.label}
                <span className="mk-soon-badge">Soon</span>
              </button>
            ),
          )}
          <a className="mk-nav-link mk-nav-sign-in" href="/sign-in">
            Sign In
          </a>
          <button
            type="button"
            className="mk-btn mk-btn-gold mk-btn-compact"
            disabled
            title={DEMO_TITLE}
          >
            Book a Demo
          </button>
        </nav>

        <button
          type="button"
          className="mk-mobile-toggle"
          aria-expanded={menuOpen}
          aria-controls="mk-mobile-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="mk-visually-hidden">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          {menuOpen ? (
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>

      <div id="mk-mobile-menu" className="mk-mobile-panel" hidden={!menuOpen}>
        <nav aria-label="Main mobile">
          {NAV_ITEMS.map((item) =>
            item.kind === 'link' ? (
              <a
                key={item.href}
                className="mk-mobile-link"
                href={item.href}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                className="mk-mobile-soon"
                disabled
                title={`${item.label} is coming soon`}
              >
                {item.label}
                <span className="mk-soon-badge">Soon</span>
              </button>
            ),
          )}
          <a className="mk-mobile-link" href="/sign-in" onClick={() => setMenuOpen(false)}>
            Sign In
          </a>
          <button
            type="button"
            className="mk-btn mk-btn-gold mk-btn-block"
            disabled
            title={DEMO_TITLE}
          >
            Book a Demo
          </button>
        </nav>
      </div>
    </header>
  );
}
