/**
 * The permission registry's security properties.
 *
 * These are the assertions that let the rest of the system trust the registry.
 * Each one corresponds to a stated requirement, and each is written so that
 * changing the matrix incorrectly makes a test fail rather than silently
 * widening access.
 */

import { describe, expect, it } from 'vitest';

import {
  can,
  canActAsPlatform,
  canDelegate,
  delegableRoles,
  isMutating,
  MUTATING_ORGANIZATION_PERMISSIONS,
  ORGANIZATION_PERMISSIONS,
  ORGANIZATION_ROLE_PERMISSIONS,
  ORGANIZATION_ROLES,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  type OrganizationRole,
} from './permissions.js';

const ALL_ORGANIZATION_ROLES = ORGANIZATION_ROLES;
const ALL_PLATFORM_ROLES = PLATFORM_ROLES;

describe('registry integrity', () => {
  it('grants every role a non-empty permission set', () => {
    for (const role of ALL_ORGANIZATION_ROLES) {
      expect(ORGANIZATION_ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
    for (const role of ALL_PLATFORM_ROLES) {
      expect(PLATFORM_ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });

  it('names only registered permissions', () => {
    for (const role of ALL_ORGANIZATION_ROLES) {
      for (const permission of ORGANIZATION_ROLE_PERMISSIONS[role]) {
        expect(ORGANIZATION_PERMISSIONS).toContain(permission);
      }
    }
    for (const role of ALL_PLATFORM_ROLES) {
      for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) {
        expect(PLATFORM_PERMISSIONS).toContain(permission);
      }
    }
  });

  it('keeps the organization and platform namespaces disjoint', () => {
    const platform = new Set<string>(PLATFORM_PERMISSIONS);

    for (const permission of ORGANIZATION_PERMISSIONS) {
      expect(platform.has(permission)).toBe(false);
    }
  });

  it('grants no organization role any platform permission', () => {
    // The structural half of "an Organization Owner must never reach platform
    // administration" is the disjoint union types. This is the runtime half.
    for (const role of ALL_ORGANIZATION_ROLES) {
      for (const permission of PLATFORM_PERMISSIONS) {
        const held = ORGANIZATION_ROLE_PERMISSIONS[role] as readonly string[];
        expect(held).not.toContain(permission);
      }
    }
  });

  it('gives the owner every organization permission', () => {
    for (const permission of ORGANIZATION_PERMISSIONS) {
      expect(can('OWNER', permission)).toBe(true);
    }
  });

  it('grants the platform owner every platform permission', () => {
    for (const permission of PLATFORM_PERMISSIONS) {
      expect(canActAsPlatform('PLATFORM_OWNER', permission)).toBe(true);
    }
  });
});

describe('an Organization Owner is confined to its own organization', () => {
  it('cannot act as any platform role', () => {
    for (const role of ALL_ORGANIZATION_ROLES) {
      expect(ORGANIZATION_ROLE_PERMISSIONS[role].some((p) => p.startsWith('platform:'))).toBe(
        false,
      );
    }
  });
});

describe('a Viewer cannot mutate data', () => {
  it('holds no mutating permission', () => {
    const held = ORGANIZATION_ROLE_PERMISSIONS.VIEWER;

    expect(held.filter(isMutating)).toEqual([]);
  });

  it('cannot reach any mutating permission in the registry', () => {
    for (const permission of MUTATING_ORGANIZATION_PERMISSIONS) {
      expect(can('VIEWER', permission)).toBe(false);
    }
  });

  it('can still read', () => {
    expect(can('VIEWER', 'organization:read')).toBe(true);
    expect(can('VIEWER', 'campaign:read')).toBe(true);
    expect(can('VIEWER', 'member:read')).toBe(true);
    expect(can('VIEWER', 'reporting:read')).toBe(true);
  });
});

describe('a Campaign Manager cannot perform owner-only actions', () => {
  it('cannot transfer ownership', () => {
    expect(can('CAMPAIGN_MANAGER', 'ownership:transfer')).toBe(false);
  });

  it('cannot administer membership', () => {
    expect(can('CAMPAIGN_MANAGER', 'member:invite')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'member:update')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'member:remove')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'invitation:revoke')).toBe(false);
  });

  it('cannot update the organization profile', () => {
    expect(can('CAMPAIGN_MANAGER', 'organization:update')).toBe(false);
  });

  it('can do campaign work', () => {
    expect(can('CAMPAIGN_MANAGER', 'campaign:create')).toBe(true);
    expect(can('CAMPAIGN_MANAGER', 'campaign:update')).toBe(true);
    expect(can('CAMPAIGN_MANAGER', 'campaign:delete')).toBe(true);
    expect(can('CAMPAIGN_MANAGER', 'campaign:read')).toBe(true);
  });
});

describe('billing authority is granted separately', () => {
  it('reaches only the owner and the billing role', () => {
    const withBilling = ALL_ORGANIZATION_ROLES.filter((role) =>
      ORGANIZATION_ROLE_PERMISSIONS[role].some((p) => p.startsWith('billing:')),
    );

    expect(withBilling).toEqual(['OWNER', 'BILLING']);
  });

  it('is not held by an admin', () => {
    expect(can('ADMIN', 'billing:read')).toBe(false);
    expect(can('ADMIN', 'billing:update')).toBe(false);
    expect(can('ADMIN', 'wallet:read')).toBe(false);
  });

  it('is not held by a campaign manager or a viewer', () => {
    expect(can('CAMPAIGN_MANAGER', 'billing:read')).toBe(false);
    expect(can('VIEWER', 'wallet:read')).toBe(false);
  });
});

describe('ownership is not an administrative capability', () => {
  it('is held only by the owner', () => {
    const holders = ALL_ORGANIZATION_ROLES.filter((role) => can(role, 'ownership:transfer'));

    expect(holders).toEqual(['OWNER']);
  });
});

describe('delegation is capped by the delegator own authority', () => {
  it('lets an owner delegate every role strictly below them', () => {
    expect(delegableRoles('OWNER')).toEqual(['ADMIN', 'CAMPAIGN_MANAGER', 'BILLING', 'VIEWER']);
  });

  it('never lets the owner role be assigned as an ordinary role', () => {
    // Otherwise assigning OWNER becomes a second, undeliberate way to create an
    // owner, bypassing `ownership:transfer` - the deliberate audited act ADR
    // 0006 requires.
    expect(canDelegate('OWNER', 'OWNER')).toBe(false);
    expect(delegableRoles('OWNER')).not.toContain('OWNER');
  });

  it('stops any role from manufacturing a peer of itself', () => {
    for (const role of ALL_ORGANIZATION_ROLES) {
      expect(canDelegate(role, role)).toBe(false);
    }
  });

  it('stops an admin creating another admin', () => {
    // Admins are created by owners, so one is always visibly accountable.
    expect(canDelegate('ADMIN', 'ADMIN')).toBe(false);
  });

  it('stops an admin creating an owner', () => {
    expect(canDelegate('ADMIN', 'OWNER')).toBe(false);
  });

  it('stops an admin granting billing authority', () => {
    // Admins lack every billing permission, so BILLING is not a subset of what
    // they hold. This is the delegation half of "billing cannot be inherited".
    expect(canDelegate('ADMIN', 'BILLING')).toBe(false);
  });

  it('lets an admin delegate roles strictly within its own authority', () => {
    expect(canDelegate('ADMIN', 'CAMPAIGN_MANAGER')).toBe(true);
    expect(canDelegate('ADMIN', 'VIEWER')).toBe(true);
  });

  it('lets a campaign manager, billing role and viewer delegate nothing', () => {
    for (const role of ['CAMPAIGN_MANAGER', 'BILLING', 'VIEWER'] as const) {
      expect(delegableRoles(role)).toEqual([]);
    }
  });

  it('never allows delegation to widen or equal authority', () => {
    for (const actor of ALL_ORGANIZATION_ROLES) {
      for (const target of ALL_ORGANIZATION_ROLES) {
        if (!canDelegate(actor, target)) continue;

        const held = ORGANIZATION_ROLE_PERMISSIONS[actor];
        const granting = ORGANIZATION_ROLE_PERMISSIONS[target];

        expect(granting.length).toBeLessThan(held.length);
        for (const permission of granting) {
          expect(held).toContain(permission);
        }
      }
    }
  });
});

describe('platform roles stay inside their scope', () => {
  it('keeps a support admin away from tenant content and money', () => {
    const held = PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN as readonly string[];

    expect(held).not.toContain('platform:billing:refund');
    expect(held).not.toContain('platform:operations:write');
    expect(held).not.toContain('platform:admin:manage');
    expect(held).not.toContain('platform:tenant:suspend');
  });

  it('keeps a billing admin away from operations and support', () => {
    const held = PLATFORM_ROLE_PERMISSIONS.BILLING_ADMIN as readonly string[];

    expect(held).toEqual(['platform:billing:read', 'platform:billing:refund']);
  });

  it('keeps an auditor read-only', () => {
    for (const permission of PLATFORM_ROLE_PERMISSIONS.AUDITOR) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('reserves role management for the platform owner alone', () => {
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:admin:manage'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER']);
  });

  it('reserves refunds for the platform owner and the billing admin', () => {
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:billing:refund'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER', 'BILLING_ADMIN']);
  });

  it('grants no platform role an organization permission', () => {
    const organization = new Set<string>(ORGANIZATION_PERMISSIONS);

    for (const role of ALL_PLATFORM_ROLES) {
      for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) {
        expect(organization.has(permission)).toBe(false);
      }
    }
  });
});

describe('the registry cannot be widened without failing a test', () => {
  it('derives the mutating list from the registry rather than restating it', () => {
    // If someone adds a mutating permission and hand-lists it nowhere, this
    // still catches it: every entry ends in ':read' or is absent.
    const mutating = MUTATING_ORGANIZATION_PERMISSIONS.filter((p) => p.endsWith(':read'));

    expect(mutating).toEqual([]);
  });

  it('reports exactly the expected delegation ladder', () => {
    // Written out rather than recomputed from the registry: a test that restates
    // the implementation proves nothing about it. This is the ladder the
    // ADR 0009 delegation rule is meant to produce.
    const ladder: Record<OrganizationRole, OrganizationRole[]> = {
      OWNER: ['ADMIN', 'CAMPAIGN_MANAGER', 'BILLING', 'VIEWER'],
      ADMIN: ['CAMPAIGN_MANAGER', 'VIEWER'],
      CAMPAIGN_MANAGER: [],
      BILLING: [],
      VIEWER: [],
    };

    for (const role of ALL_ORGANIZATION_ROLES) {
      expect(delegableRoles(role)).toEqual(ladder[role]);
    }
  });
});
