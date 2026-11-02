import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SettingsAccessNotice, SettingsHeader, SettingsNav } from './settings-ui';

describe('SettingsHeader', () => {
  it('places the page inside the platform Settings workspace', () => {
    const markup = renderToStaticMarkup(<SettingsHeader title="Payment integrations" />);
    expect(markup).toContain('PLATFORM SETTINGS');
    expect(markup).toContain('Payment integrations');
  });
});

describe('SettingsNav', () => {
  it('marks the active section and links both settings routes', () => {
    const markup = renderToStaticMarkup(<SettingsNav current="payments" />);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('/settings/payments');
    expect(markup).toContain('/settings');
  });
});

describe('SettingsAccessNotice', () => {
  it('renders nothing once access is established', () => {
    expect(renderToStaticMarkup(<SettingsAccessNotice status={null} />)).toBe('');
  });

  it('explains that only the platform Super Admin may manage payment credentials', () => {
    const markup = renderToStaticMarkup(<SettingsAccessNotice status={403} />);
    expect(markup).toContain('Super Admin only');
    expect(markup).toContain('does not include access to payment-provider credentials');
  });

  it('points an unauthenticated operator at sign-in', () => {
    expect(renderToStaticMarkup(<SettingsAccessNotice status={401} />)).toContain('Sign in');
  });

  it('reports an API outage without guessing at the data', () => {
    expect(renderToStaticMarkup(<SettingsAccessNotice status={503} />)).toContain(
      'temporarily unavailable',
    );
  });
});
