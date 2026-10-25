import { describe, expect, it } from 'vitest';

import { platformNavigationItems } from './PlatformShell';

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
      'Audit',
    ]);
    expect(platformNavigationItems('AUDITOR').map((item) => item.label)).toEqual([
      'Operations',
      'Support',
      'Audit',
    ]);
    expect(platformNavigationItems('BILLING_ADMIN')).toEqual([]);
    expect(platformNavigationItems(null)).toEqual([]);
  });
});
