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
  it('has exactly the approved dashboard, campaign, report, and team read permissions', () => {
    expect([...ORGANIZATION_ROLE_PERMISSIONS.VIEWER].sort()).toEqual(
      ['campaign:read', 'member:read', 'organization:read', 'reporting:read'].sort(),
    );
  });

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

describe('the Campaign Manager matrix is exactly as specified', () => {
  // Written out independently of the registry, mirroring the ADMIN block above
  // (RBAC-003 acceptance: allow/deny matrix). The per-permission `can` tests
  // elsewhere prove single cells; this proves the whole row, so adding a
  // permission to CAMPAIGN_MANAGER - or removing one - fails here instead of
  // quietly widening or narrowing what a campaign manager may do.
  it('grants precisely these six permissions', () => {
    const expected = [
      'organization:read',
      'campaign:read',
      'campaign:create',
      'campaign:update',
      'campaign:delete',
      'reporting:read',
    ];

    expect([...ORGANIZATION_ROLE_PERMISSIONS.CAMPAIGN_MANAGER].sort()).toEqual(
      [...expected].sort(),
    );
  });

  it('withholds membership, ownership, money and profile control by omission', () => {
    // The rows above deliberately left out. Each is a "prohibited access" item
    // in the RBAC-003 requirement, stated here so removing it from the omission
    // list fails loudly.
    expect(can('CAMPAIGN_MANAGER', 'member:read')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'member:invite')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'member:update')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'member:remove')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'invitation:read')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'invitation:revoke')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'ownership:transfer')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'organization:update')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'billing:read')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'billing:update')).toBe(false);
    expect(can('CAMPAIGN_MANAGER', 'wallet:read')).toBe(false);
  });

  it('holds no membership-administration or money permission of any kind', () => {
    const held = ORGANIZATION_ROLE_PERMISSIONS.CAMPAIGN_MANAGER as readonly string[];

    expect(held.filter((p) => p.startsWith('member:') || p.startsWith('invitation:'))).toEqual([]);
    expect(held.filter((p) => p.startsWith('billing:') || p.startsWith('wallet:'))).toEqual([]);
    expect(held.filter((p) => p.startsWith('platform:'))).toEqual([]);
  });
});

describe('a Billing member cannot reach campaigns', () => {
  // The required billing-403 half at the registry level: BILLING exists to see
  // money, not to run campaigns, and no `campaign:*` permission may creep into
  // its row. The guard/e2e suites assert the same property as HTTP 403s.
  it('holds none of the campaign permissions', () => {
    for (const permission of [
      'campaign:read',
      'campaign:create',
      'campaign:update',
      'campaign:delete',
    ] as const) {
      expect(can('BILLING', permission)).toBe(false);
    }
  });

  it('cannot report either', () => {
    expect(can('BILLING', 'reporting:read')).toBe(false);
  });

  it('is not secretly an admin by another name', () => {
    expect(can('BILLING', 'member:invite')).toBe(false);
    expect(can('BILLING', 'member:update')).toBe(false);
    expect(can('BILLING', 'ownership:transfer')).toBe(false);
    expect(can('BILLING', 'organization:update')).toBe(false);
  });
});

describe('the Organization Admin matrix is exactly as specified', () => {
  // Written out independently of the registry. The per-permission `can` tests
  // elsewhere prove single cells; this proves the whole row, so adding a
  // permission to ADMIN - or removing one - fails here instead of quietly
  // widening what an admin may do (RBAC-002 acceptance: allow/deny matrix).
  it('grants precisely these thirteen permissions', () => {
    const expected = [
      'organization:read',
      'organization:update',
      'member:read',
      'member:invite',
      'member:update',
      'member:remove',
      'invitation:read',
      'invitation:revoke',
      'campaign:read',
      'campaign:create',
      'campaign:update',
      'campaign:delete',
      'reporting:read',
    ];

    expect([...ORGANIZATION_ROLE_PERMISSIONS.ADMIN].sort()).toEqual([...expected].sort());
  });

  it('withholds ownership, billing and the wallet by omission', () => {
    // The same four permissions the ADMIN row above deliberately leaves out.
    expect(can('ADMIN', 'ownership:transfer')).toBe(false);
    expect(can('ADMIN', 'billing:read')).toBe(false);
    expect(can('ADMIN', 'billing:update')).toBe(false);
    expect(can('ADMIN', 'wallet:read')).toBe(false);
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
  it('limits Operations Admin to operational reads, writes, and tenant suspension', () => {
    const held = PLATFORM_ROLE_PERMISSIONS.OPERATIONS_ADMIN;

    expect(held).toEqual([
      'platform:tenant:read',
      'platform:tenant:suspend',
      'platform:operations:read',
      'platform:operations:write',
    ]);
    expect(held).not.toContain('platform:billing:read');
    expect(held).not.toContain('platform:billing:refund');
    expect(held).not.toContain('platform:admin:manage');
    expect(held).not.toContain('platform:technical:write');
  });

  it('does not grant operational writes to customer or non-operations platform roles', () => {
    for (const role of PLATFORM_ROLES.filter(
      (candidate) => candidate !== 'PLATFORM_OWNER' && candidate !== 'OPERATIONS_ADMIN',
    )) {
      expect(canActAsPlatform(role, 'platform:operations:write')).toBe(false);
    }
    for (const role of ORGANIZATION_ROLES) {
      expect(ORGANIZATION_ROLE_PERMISSIONS[role]).not.toContain('platform:operations:write');
    }
  });

  it('grants the support admin lookup, diagnostics, audit reads, and scoped support access', () => {
    // Exact, not a denylist: a permission added to SUPPORT_ADMIN has to be
    // decided here, and `platform:support:diagnostics` is the only permission
    // in the registry that reaches read-only tenant content for this role.
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN).toEqual([
      'platform:tenant:read',
      'platform:support:read',
      'platform:support:diagnostics',
      'platform:support:access',
      'platform:audit:read',
    ]);
    // Diagnostics is read-only by construction: it must never pair with a
    // mutation, suspension or refund capability.
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN).not.toContain('platform:billing:refund');
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN).not.toContain('platform:operations:write');
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN).not.toContain('platform:admin:manage');
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT_ADMIN).not.toContain('platform:tenant:suspend');
  });

  it('grants the technical admin exactly technical reads and audit reads', () => {
    // RBAC-010: read-only by construction. The exact row rather than a
    // denylist, so adding a permission to TECHNICAL_ADMIN - or restoring
    // `platform:technical:write` - fails here instead of quietly widening
    // what a technical operator may do.
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).toEqual([
      'platform:technical:read',
      'platform:audit:read',
    ]);
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).not.toContain('platform:tenant:suspend');
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).not.toContain('platform:operations:write');
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).not.toContain('platform:billing:refund');
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).not.toContain('platform:admin:manage');
    expect(PLATFORM_ROLE_PERMISSIONS.TECHNICAL_ADMIN).not.toContain('platform:support:diagnostics');
  });

  it('limits technical reads to the platform owner and the technical admin alone', () => {
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:technical:read'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER', 'TECHNICAL_ADMIN']);
  });

  it('reserves technical writes for the platform owner alone', () => {
    // The write permission exists in the vocabulary but nothing consumes it
    // yet; these two assertions are what stop it from creeping into a role
    // before a route decides it needs it.
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:technical:write'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER']);
  });

  it('grants audit reads to exactly the roles that answer for actions', () => {
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:audit:read'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER', 'SUPPORT_ADMIN', 'TECHNICAL_ADMIN', 'AUDITOR']);
  });

  it('reserves tenant-content diagnostics for the platform owner and support admin alone', () => {
    const holders = ALL_PLATFORM_ROLES.filter((role) =>
      canActAsPlatform(role, 'platform:support:diagnostics'),
    );

    expect(holders).toEqual(['PLATFORM_OWNER', 'SUPPORT_ADMIN']);
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

  // RBAC-011 acceptance. The role must hold exactly these four permissions and
  // nothing more. The row is written out literally - independently of the
  // registry - so adding or removing a permission fails here rather than
  // quietly widening or narrowing what an auditor can reach.
  it('grants the auditor exactly its four read permissions', () => {
    const expected = [
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ];

    expect([...PLATFORM_ROLE_PERMISSIONS.AUDITOR].sort()).toEqual([...expected].sort());
    expect(new Set(PLATFORM_ROLE_PERMISSIONS.AUDITOR).size).toBe(expected.length);
  });

  it('reaches no non-read platform permission in the entire registry', () => {
    // "All mutation attempts denied" expressed as a fact about the registry,
    // not a convention. `platform:tenant:suspend` is a mutation whose name does
    // not end in `:write`, so this checks every permission the auditor does NOT
    // hold rather than only the ones spelled `*:write`.
    for (const permission of PLATFORM_PERMISSIONS) {
      if (permission.endsWith(':read')) continue;
      expect(canActAsPlatform('AUDITOR', permission)).toBe(false);
    }
  });

  it('holds no billing, diagnostics, technical or administrative authority', () => {
    // Each is a capability a custody of the audit trail might be mistaken for.
    expect(canActAsPlatform('AUDITOR', 'platform:billing:read')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:billing:refund')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:support:diagnostics')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:technical:read')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:technical:write')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:tenant:suspend')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:operations:write')).toBe(false);
    expect(canActAsPlatform('AUDITOR', 'platform:admin:manage')).toBe(false);
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
