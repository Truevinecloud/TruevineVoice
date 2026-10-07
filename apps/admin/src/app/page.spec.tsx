import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AdminHomePage from './page';
import { ADMIN_APP_INFO } from '../lib/app-info';

describe('admin placeholder page', () => {
  it('renders the product name and the admin surface', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('Truevine Voice Admin');
    expect(markup).toContain(ADMIN_APP_INFO.surface);
  });

  it('states that no admin functionality exists yet', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('Foundation');
    expect(markup).toContain('No admin functionality yet');
  });

  it('names its intended audience', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('internal operators');
  });
});
