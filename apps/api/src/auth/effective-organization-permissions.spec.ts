import { ORGANIZATION_PERMISSIONS, PLATFORM_PERMISSIONS } from '@truevine/auth';
import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOM_DELEGABLE_PERMISSIONS,
  checkEffectiveOrganizationPermission,
  effectiveOrganizationPermissions,
} from './effective-organization-permissions.js';

describe('effective organization permissions', () => {
  it('uses the exact approved split without inheriting platform or built-in authority', () => {
    expect(CUSTOM_DELEGABLE_PERMISSIONS).toEqual([
      'organization:read', 'campaign:read', 'campaign:create', 'campaign:delete',
      'audio:read', 'contact:read', 'contact:create', 'reporting:read',
    ]);
    expect(CUSTOM_DELEGABLE_PERMISSIONS).not.toContain('campaign:launch');
    expect(CUSTOM_DELEGABLE_PERMISSIONS).not.toContain('campaign:pause');
    expect(CUSTOM_DELEGABLE_PERMISSIONS).not.toContain('campaign:resume');
    expect(CUSTOM_DELEGABLE_PERMISSIONS).not.toContain('campaign:cancel');
    expect(ORGANIZATION_PERMISSIONS.filter((permission) =>
      !CUSTOM_DELEGABLE_PERMISSIONS.some((delegable) => delegable === permission),
    )).toHaveLength(19);
    expect(PLATFORM_PERMISSIONS).toHaveLength(15);
    expect(effectiveOrganizationPermissions('VIEWER', ['campaign:create', 'billing:read']))
      .toContain('campaign:create');
    expect(effectiveOrganizationPermissions('VIEWER', ['billing:read'])).not.toContain('billing:read');
  });

  it('fails closed on invalid data or lookup failure and preserves independent built-in authority', async () => {
    const invalid = vi.fn().mockResolvedValue(['campaign:create', 'platform:admin:manage']);
    await expect(checkEffectiveOrganizationPermission('VIEWER', 'campaign:create', invalid))
      .resolves.toBe('custom_grants_unavailable');
    const unavailable = vi.fn().mockRejectedValue(new Error('private lookup failure'));
    await expect(checkEffectiveOrganizationPermission('VIEWER', 'campaign:read', unavailable))
      .resolves.toBe('allowed');
    await expect(checkEffectiveOrganizationPermission('VIEWER', 'billing:read', unavailable))
      .resolves.toBe('insufficient_permission');
    expect(unavailable).not.toHaveBeenCalled();
    await expect(checkEffectiveOrganizationPermission('VIEWER', 'campaign:create', unavailable))
      .resolves.toBe('custom_grants_unavailable');
    // Lifecycle permissions are built into CAMPAIGN_MANAGER, so they are
    // allowed without consulting custom grants. A custom grant must still be
    // unable to delegate a non-delegable permission such as billing:update.
    const builtInLaunch = vi.fn();
    await expect(
      checkEffectiveOrganizationPermission('CAMPAIGN_MANAGER', 'campaign:launch', builtInLaunch),
    ).resolves.toBe('allowed');
    expect(builtInLaunch).not.toHaveBeenCalled();
    const billingGrant = vi.fn().mockResolvedValue(['billing:update']);
    await expect(
      checkEffectiveOrganizationPermission('CAMPAIGN_MANAGER', 'billing:update', billingGrant),
    ).resolves.toBe('insufficient_permission');
    expect(billingGrant).not.toHaveBeenCalled();
  });
});
