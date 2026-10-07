import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage from './page';
import { WEB_APP_INFO } from '../lib/app-info';

describe('web placeholder page', () => {
  it('renders the product name', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Truevine Voice');
    expect(markup).toContain(WEB_APP_INFO.surface);
  });

  it('states that no product functionality exists yet', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('Foundation');
    expect(markup).toContain('No product functionality has been implemented yet');
  });

  it('points at the API health endpoint', () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('/health');
  });
});
