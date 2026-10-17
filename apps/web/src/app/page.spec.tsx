import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage from './page';
import { WEB_APP_INFO } from '../lib/app-info';

describe('marketing homepage', () => {
  it('renders the marketing headline and highlights automated voice calls', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Reach thousands with');
    expect(markup).toContain('class="mk-gold"');
    expect(markup).toContain('automated voice calls');
  });

  it('carries the required supporting copy', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Send reminders, announcements and customer updates');
    expect(markup).toContain('in local languages');
    expect(markup).toContain('without call');
    expect(markup).toContain('centre staff');
  });

  it('presents the required benefit highlights', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Works with supported Uganda networks');
    expect(markup).toContain('Local language voice and AI capabilities');
    expect(markup).toContain('Easy setup, powerful results');
  });

  it('links Sign In to the existing sign-in route', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain('Sign In');
  });

  it('keeps Start Free Trial and Book a Demo as disabled placeholders, not links', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    // There is no public sign-up and no demo-booking flow, so neither call to
    // action may point at a route that does not exist.
    expect(markup).not.toMatch(/<a[^>]*>\s*Start Free Trial\s*<\/a>/);
    expect(markup).not.toMatch(/<a[^>]*>\s*Book a Demo\s*<\/a>/);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Start Free Trial\s*<\/button>/);
    expect(markup).toContain('title="Self-serve sign-up is coming soon"');
    expect(markup).toContain('title="Demo scheduling is coming soon"');
  });

  it('marks Pricing and Resources as coming-soon placeholders in the navigation', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Pricing');
    expect(markup).toContain('Resources');
    expect(markup).toContain('mk-soon-badge');
    expect(markup).toContain('title="Pricing is coming soon"');
    expect(markup).toContain('title="Resources is coming soon"');
  });

  it('provides a mobile navigation toggle with correct ARIA state', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="mk-mobile-menu"');
    expect(markup).toContain('id="mk-mobile-menu"');
    expect(markup).toContain('Open menu');
  });

  it('labels campaign statistics as illustrative sample data', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Illustrative sample data');
    expect(markup).toContain('not real customer figures');
    expect(markup).toContain('Sample');
  });

  it('states the honest production status without claiming live integrations', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('is in development');
    expect(markup).toContain('product plans');
    expect(markup).toContain('not yet available');
    expect(markup).toContain('as live production features');
  });

  it('names the product and contains no previous brand', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain(WEB_APP_INFO.product);
    expect(markup).not.toContain('CallHub');
  });

  it('presents the solutions band for the everyday use cases', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('id="solutions"');
    expect(markup).toContain('Payment reminders');
    expect(markup).toContain('Announcements');
    expect(markup).toContain('Customer updates');
  });
});
