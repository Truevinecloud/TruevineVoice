import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AdminHomePage from './page';
import { ADMIN_APP_INFO } from '../lib/app-info';

describe('Operations Admin page', () => {
  it('renders the operations console', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('Operations');
    expect(markup).toContain('Platform sign in');
  });

  it('retains the platform-admin audience metadata', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(ADMIN_APP_INFO.audience).toContain('internal operators');
    expect(markup).toContain('Checking platform access');
  });
});
