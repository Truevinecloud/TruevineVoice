import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage from './page';
import { WEB_APP_INFO } from '../lib/app-info';

describe('web placeholder page', () => {
  it('describes the planned Uganda experience without claiming calling is available', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('aria-labelledby="roadmap-heading"');
    expect(markup).toContain('Built for customer conversations in Uganda');
    expect(markup).toContain('Coming next');
    expect(markup).toContain('not available yet');
  });

  it('presents the live public web surface and names the deployment target', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Live web for voice');
    expect(markup).toContain('voice.truevinecloud.online');
    expect(markup).toContain('Live');
  });

  it('does not imply the voice product itself is available', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('still under construction');
    expect(markup).toContain('Voice calling and');
  });
  it('renders the product name', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Truevine Voice');
    expect(markup).toContain(WEB_APP_INFO.surface);
  });

  it('states the platform is live while no product functionality exists yet', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Live');
    expect(markup).toContain('the voice product is still under construction');
  });

  it('points at the API health endpoint', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('/health');
  });
});
