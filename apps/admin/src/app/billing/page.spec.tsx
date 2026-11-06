import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import BillingAdminPage from './page';

describe('BillingAdminPage', () => {
  it('renders the billing workspace shell', () => {
    const markup = renderToStaticMarkup(<BillingAdminPage />);
    expect(markup).toContain('PLATFORM BILLING');
    expect(markup).toContain('Billing Admin');
  });
});
