import { describe, expect, it } from 'vitest';

import { isPlatformNavItemActive, platformNavigationItems } from './PlatformShell';

describe('platform navigation entitlements', () => {
  it('keeps platform administration separate and lists only entitled workspaces', () => {
    expect(platformNavigationItems('OPERATIONS_ADMIN').map((item) => item.label)).toEqual([
      'Operations',
    ]);
    expect(platformNavigationItems('SUPPORT_ADMIN').map((item) => item.label)).toEqual([
      'Support',
      'Audit',
    ]);
    expect(platformNavigationItems('TECHNICAL_ADMIN').map((item) => item.label)).toEqual([
      'Technical',
    ]);
    expect(platformNavigationItems('AUDITOR').map((item) => item.label)).toEqual([
      'Operations',
      'Support',
      'Audit',
    ]);
    expect(platformNavigationItems('BILLING_ADMIN').map((item) => item.label)).toEqual(['Billing']);
    expect(platformNavigationItems(null)).toEqual([]);
    expect(platformNavigationItems('PLATFORM_OWNER').map((item) => item.label)).toEqual([
      'Operations',
      'Support',
      'Technical',
      'Audit',
      'Settings',
      'Billing',
      'Platform Admins',
    ]);
  });
});

describe('platform navigation active state', () => {
  it('highlights the exact dashboard route only on the root path', () => {
    expect(isPlatformNavItemActive('/', '/')).toBe(true);
    expect(isPlatformNavItemActive('/support', '/')).toBe(false);
  });

  it('highlights a section for its route and nested routes', () => {
    expect(isPlatformNavItemActive('/settings', '/settings')).toBe(true);
    expect(isPlatformNavItemActive('/settings/payments', '/settings')).toBe(true);
    expect(isPlatformNavItemActive('/support/users/123', '/support')).toBe(true);
    expect(isPlatformNavItemActive('/technical', '/support')).toBe(false);
  });
});
