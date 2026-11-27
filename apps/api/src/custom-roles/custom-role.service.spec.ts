import { auditDigest } from '../auth/sensitive-audit.js';
import { CustomRolesController } from './custom-roles.controller.js';
import { aUser, FakeAuthStore } from '../../test/fakes/auth.fakes.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthError, type OrganizationRole } from '@truevine/auth';
import { CustomRoleService } from './custom-role.service.js';
import {
  FakeCustomRoleStore,
  FakeOrganizationStoreForCustomRoles,
  FakeAuditStoreForCustomRoles,
  FakeSecurityTransactionForCustomRoles,
  aCustomRole,
} from './custom-role.fakes.js';

const ownerRole: OrganizationRole = 'OWNER';
const adminRole: OrganizationRole = 'ADMIN';
const viewerRole: OrganizationRole = 'VIEWER';

describe('CustomRoleService', () => {
  let service: CustomRoleService;
  let auth: FakeAuthStore;
  let customRoles: FakeCustomRoleStore;
  let organizations: FakeOrganizationStoreForCustomRoles;
  let audit: FakeAuditStoreForCustomRoles;
  let transaction: FakeSecurityTransactionForCustomRoles;

  beforeEach(() => {
    auth = new FakeAuthStore();
    auth.users.push(aUser({ id: 'actor-1' }));
    customRoles = new FakeCustomRoleStore();
    organizations = new FakeOrganizationStoreForCustomRoles();
    audit = new FakeAuditStoreForCustomRoles();
    transaction = new FakeSecurityTransactionForCustomRoles(
      customRoles,
      organizations,
      audit,
      auth,
    );
    service = new CustomRoleService(customRoles, organizations, audit, transaction);

    // Add actor as OWNER membership
    organizations.addMembership('actor-1', ownerRole);
  });

  it('conceals a foreign role and preserves its data and assignments', async () => {
    const role = aCustomRole({ organizationId: 'org-2', name: 'Foreign role' });
    const assignment = {
      organizationId: 'org-2',
      roleId: role.id,
      userId: 'user-2',
      createdAt: new Date(),
    };
    customRoles.roles.push(role);
    customRoles.assignments.push(assignment);
    organizations.addMembership('user-2', viewerRole);

    const scope = ['org-1', role.id, 'actor-1', ownerRole, []] as const;
    const concealed = { code: 'role_not_found', status: 404 };
    await expect(service.listRoles('org-1', 'actor-1', ownerRole, [])).resolves.toEqual([]);
    await expect(service.getRole(...scope)).rejects.toMatchObject(concealed);
    await expect(service.listAssignments(...scope)).rejects.toMatchObject(concealed);
    await expect(service.updateRole(...scope, { name: 'Changed' })).rejects.toMatchObject(
      concealed,
    );
    await expect(service.deleteRole(...scope)).rejects.toMatchObject(concealed);
    await expect(service.assignUser(...scope, 'user-2')).rejects.toMatchObject(concealed);
    await expect(service.unassignUser(...scope, 'user-2')).rejects.toMatchObject(concealed);

    expect(customRoles.roles).toEqual([{ ...role, name: 'Foreign role' }]);
    expect(customRoles.assignments).toEqual([assignment]);
  });

  it.each(['downgrade', 'remove', 'suspend'] as const)(
    'denies a mutation when a concurrent %s wins the organization lock',
    async (change) => {
      transaction.beforeOrganizationLock = () => {
        if (change === 'downgrade') organizations.memberships[0]!.role = 'VIEWER';
        if (change === 'remove') organizations.memberships.length = 0;
        if (change === 'suspend') auth.users[0]!.status = 'SUSPENDED';
      };
      await expect(
        service.createRole('org-1', 'actor-1', ownerRole, [], {
          name: 'Must not persist',
          permissions: ['organization:read'],
        }),
      ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
      expect(customRoles.roles).toEqual([]);
      expect(audit.events).toEqual([]);
    },
  );

  it('rejects a custom delegation grant revoked before the lock', async () => {
    organizations.memberships[0]!.role = adminRole;
    const delegation = aCustomRole();
    customRoles.roles.push(delegation);
    customRoles.permissions.push({
      organizationId: 'org-1',
      roleId: delegation.id,
      permission: 'billing:read',
    });
    customRoles.assignments.push({
      organizationId: 'org-1',
      roleId: delegation.id,
      userId: 'actor-1',
      createdAt: new Date(),
    });
    transaction.beforeOrganizationLock = () => {
      customRoles.assignments.length = 0;
    };

    await expect(
      service.createRole('org-1', 'actor-1', adminRole, ['billing:read'], {
        name: 'Must not persist',
        permissions: ['billing:read'],
      }),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
    expect(customRoles.roles).toEqual([delegation]);
    expect(audit.events).toEqual([]);
  });

  it('rereads target privilege and membership after locking', async () => {
    organizations.memberships[0]!.role = adminRole;
    organizations.addMembership('user-2', viewerRole);
    const role = aCustomRole();
    customRoles.roles.push(role);
    transaction.beforeOrganizationLock = () => {
      customRoles.permissions.push({
        organizationId: 'org-1',
        roleId: role.id,
        permission: 'ownership:transfer',
      });
    };
    await expect(
      service.assignUser('org-1', role.id, 'actor-1', ownerRole, [], 'user-2'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });

    customRoles.permissions.length = 0;
    transaction.beforeOrganizationLock = () => {
      organizations.memberships[1]!.organizationId = 'org-2';
    };
    await expect(
      service.assignUser('org-1', role.id, 'actor-1', ownerRole, [], 'user-2'),
    ).rejects.toMatchObject({ status: 404 });
    expect(customRoles.assignments).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('refuses deletion if an assignment wins the lock', async () => {
    const role = aCustomRole();
    customRoles.roles.push(role);
    transaction.beforeOrganizationLock = () => {
      customRoles.assignments.push({
        organizationId: 'org-1',
        roleId: role.id,
        userId: 'user-2',
        createdAt: new Date(),
      });
    };
    await expect(
      service.deleteRole('org-1', role.id, 'actor-1', ownerRole, []),
    ).rejects.toMatchObject({ status: 409 });
    expect(customRoles.roles).toEqual([role]);
    expect(audit.events).toEqual([]);
  });

  it.each(['create', 'update', 'delete', 'assign', 'unassign'] as const)(
    'stages the %s mutation and rolls it back when the mandatory audit insert fails',
    async (operation) => {
      organizations.addMembership('user-2', viewerRole);
      const role = aCustomRole({ name: 'Original' });
      customRoles.roles.push(role);
      customRoles.permissions.push({
        organizationId: 'org-1',
        roleId: role.id,
        permission: 'organization:read',
      });
      if (operation === 'unassign') {
        customRoles.assignments.push({
          organizationId: 'org-1',
          roleId: role.id,
          userId: 'user-2',
          createdAt: new Date(),
        });
      }
      const before = structuredClone(customRoles);
      audit.failure = new Error('Audit unavailable');

      const mutations = {
        create: () =>
          service.createRole('org-1', 'actor-1', ownerRole, [], {
            name: 'New',
            permissions: ['contact:read'],
          }),
        update: () =>
          service.updateRole('org-1', role.id, 'actor-1', ownerRole, [], {
            name: 'Changed',
            permissions: ['contact:read'],
          }),
        delete: () => service.deleteRole('org-1', role.id, 'actor-1', ownerRole, []),
        assign: () => service.assignUser('org-1', role.id, 'actor-1', ownerRole, [], 'user-2'),
        unassign: () => service.unassignUser('org-1', role.id, 'actor-1', ownerRole, [], 'user-2'),
      };
      await expect(mutations[operation]()).rejects.toBe(audit.failure);
      expect(customRoles.roles).toEqual(before.roles);
      expect(customRoles.permissions).toEqual(before.permissions);
      expect(customRoles.assignments).toEqual(before.assignments);
      expect(audit.events).toEqual([]);

      audit.failure = undefined;
      await mutations[operation]();
      expect(audit.events).toHaveLength(1);
      const action = {
        create: 'created',
        update: 'updated',
        delete: 'deleted',
        assign: 'assigned',
        unassign: 'unassigned',
      }[operation];
      expect(audit.events[0]).toMatchObject({
        action: 'custom_role.' + action,
        outcome: 'SUCCESS',
      });
    },
  );

  it('audits the actual pre-update state read after the lock and the persisted result', async () => {
    const role = aCustomRole({ name: 'Before request' });
    customRoles.roles.push(role);
    transaction.beforeOrganizationLock = () => {
      role.name = 'Committed before lock';
      customRoles.permissions.push({
        organizationId: 'org-1',
        roleId: role.id,
        permission: 'organization:read',
      });
    };
    await service.updateRole('org-1', role.id, 'actor-1', ownerRole, [], {
      name: 'Updated',
      permissions: ['contact:read'],
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.metadata).toMatchObject({
      before: { name: 'Committed before lock', permissions: ['organization:read'] },
      after: { name: 'Updated', permissions: ['contact:read'] },
    });
  });

  it('requests ReadCommitted and audits a stale actor refusal after rollback', async () => {
    transaction.beforeOrganizationLock = () => {
      organizations.memberships[0]!.role = viewerRole;
    };
    const record = audit.recordIdentity.bind(audit);
    vi.spyOn(audit, 'recordIdentity').mockImplementation(async (event) => {
      expect(transaction.active).toBe(false);
      await record(event);
    });
    await expect(
      service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Denied',
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });

    expect(transaction.options).toEqual({ isolationLevel: 'ReadCommitted' });
    expect(audit.identityEvents).toEqual([
      {
        actorUserId: 'actor-1',
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: {
          operation: 'custom_role.created',
          reason: 'cannot_delegate_beyond_own_authority',
          attemptedOrganizationDigest: auditDigest('org-1'),
        },
      },
    ]);
    expect(customRoles.roles).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('audits a cross-tenant role denial once without storing target identifiers or state', async () => {
    const foreign = aCustomRole({ organizationId: 'foreign-tenant', name: 'Foreign private name' });
    customRoles.roles.push(foreign);

    await expect(
      service.deleteRole('org-1', foreign.id, 'actor-1', ownerRole, []),
    ).rejects.toMatchObject({ code: 'role_not_found' });

    expect(audit.identityEvents).toHaveLength(1);
    expect(audit.identityEvents[0]?.metadata).toEqual({
      operation: 'custom_role.deleted',
      reason: 'role_not_found',
      attemptedOrganizationDigest: auditDigest('org-1'),
    });
    expect(customRoles.roles).toEqual([foreign]);
    expect(audit.events).toEqual([]);
  });

  it('preserves the original denial and emits a safe warning if the audit insert fails', async () => {
    organizations.memberships[0]!.role = viewerRole;
    audit.identityFailure = new Error('private database failure');
    const signal = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        service.deleteRole('org-1', 'target', 'actor-1', ownerRole, []),
      ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority', status: 403 });
      expect(signal.mock.calls).toEqual([
        ['[authorization] Custom-role denial audit unavailable.\n'],
      ]);
      expect(audit.identityEvents).toEqual([]);
      expect(audit.events).toEqual([]);
    } finally {
      signal.mockRestore();
    }
  });

  describe('PATCH semantics through the controller', () => {
    const context = { organizationId: 'org-1', role: ownerRole };
    const principal = {
      userId: 'actor-1',
      email: 'operator@example.invalid',
      sessionId: 'session-1',
      platformRole: null,
    };

    it.each([
      ['empty', {}],
      [
        'identical',
        {
          name: 'Original',
          description: 'Kept',
          permissions: ['contact:read', 'organization:read'],
        },
      ],
    ] as const)(
      'returns the locked state without a write or audit for a %s PATCH',
      async (_, body) => {
        const role = aCustomRole({ name: 'Original', description: 'Kept' });
        customRoles.roles.push(role);
        customRoles.permissions.push(
          { organizationId: 'org-1', roleId: role.id, permission: 'organization:read' },
          { organizationId: 'org-1', roleId: role.id, permission: 'contact:read' },
        );
        const result = await new CustomRolesController(service).updateRole(
          context,
          principal,
          role.id,
          body,
        );
        expect(result).toMatchObject({
          name: 'Original',
          description: 'Kept',
          updatedAt: role.updatedAt.toISOString(),
        });
        expect(customRoles.roles).toEqual([role]);
        expect(audit.events).toEqual([]);
        expect(audit.identityEvents).toEqual([]);
      },
    );

    it.each([
      ['unknown-only array', ['tenant:unknown']],
      ['mixed valid and unknown array', ['organization:read', 'tenant:unknown']],
      ['platform permission', ['platform:admin:manage']],
      ['duplicate permission', ['organization:read', 'organization:read']],
      ['malformed entry', ['organization:read', { permission: 'contact:read' }]],
      ['null field', null],
      ['non-array field', 'organization:read'],
    ] as const)('rejects a %s before mutation or audit', async (_, permissions) => {
      const role = aCustomRole({ name: 'Original' });
      customRoles.roles.push(role);
      const grant = { organizationId: 'org-1', roleId: role.id, permission: 'contact:read' } as const;
      customRoles.permissions.push(grant);
      const mutation = vi.spyOn(service, 'updateRole');

      await expect(
        new CustomRolesController(service).updateRole(context, principal, role.id, {
          name: 'Must not be applied',
          permissions,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { error: { code: 'invalid_request' } },
      });
      expect(mutation).not.toHaveBeenCalled();
      expect(customRoles.roles).toEqual([role]);
      expect(customRoles.permissions).toEqual([grant]);
      expect(audit.events).toEqual([]);
      expect(audit.identityEvents).toEqual([]);
    });

    it('preserves omitted permissions and clears them on an explicit empty array', async () => {
      const role = aCustomRole({ name: 'Original' });
      customRoles.roles.push(role);
      customRoles.permissions.push({
        organizationId: 'org-1', roleId: role.id, permission: 'contact:read',
      });
      const controller = new CustomRolesController(service);

      await expect(controller.updateRole(context, principal, role.id, { name: 'Renamed' }))
        .resolves.toMatchObject({ permissions: ['contact:read'] });
      expect(audit.events[0]?.metadata['change']).toEqual({ name: 'Renamed' });

      await expect(controller.updateRole(context, principal, role.id, { permissions: [] }))
        .resolves.toMatchObject({ permissions: [] });
      expect(audit.events[1]?.metadata).toMatchObject({
        before: { permissions: ['contact:read'] },
        change: { permissions: [] },
        after: { permissions: [] },
      });
      expect(audit.events).toHaveLength(2);
    });

    it('sends recognized permissions to the service for delegation checks and denial auditing', async () => {
      organizations.memberships[0]!.role = adminRole;
      const role = aCustomRole();
      customRoles.roles.push(role);

      await expect(new CustomRolesController(service).updateRole(
        { ...context, role: adminRole }, principal, role.id, { permissions: ['ownership:transfer'] },
      )).rejects.toMatchObject({ status: 403, code: 'cannot_delegate_beyond_own_authority' });
      expect(customRoles.permissions).toEqual([]);
      expect(audit.events).toEqual([]);
      expect(audit.identityEvents).toHaveLength(1);
      expect(audit.identityEvents[0]).toMatchObject({
        action: 'authorization.denied', outcome: 'DENIED',
        metadata: { operation: 'custom_role.updated' },
      });
    });


    it('preserves an omitted description and clears it on explicit null', async () => {
      const role = aCustomRole({ name: 'Original', description: 'Kept' });
      customRoles.roles.push(role);
      const controller = new CustomRolesController(service);
      await expect(
        controller.updateRole(context, principal, role.id, { name: 'Renamed' }),
      ).resolves.toMatchObject({ description: 'Kept' });
      expect(audit.events[0]?.metadata).toMatchObject({
        before: { descriptionDigest: auditDigest('Kept') },
        after: { descriptionDigest: auditDigest('Kept') },
      });
      expect(audit.events[0]?.metadata['change']).toEqual({ name: 'Renamed' });

      await expect(
        controller.updateRole(context, principal, role.id, { description: null }),
      ).resolves.toMatchObject({ name: 'Renamed', description: null });
      expect(audit.events[1]?.metadata).toMatchObject({
        before: { descriptionDigest: auditDigest('Kept') },
        after: { descriptionDigest: null },
      });
      expect(audit.events[1]?.metadata['change']).toEqual({ descriptionDigest: null });
      expect(audit.events).toHaveLength(2);
    });
  });

  describe('listRoles', () => {
    it('returns roles for OWNER', async () => {
      const roles = await service.listRoles('org-1', 'actor-1', ownerRole, []);
      expect(roles).toHaveLength(0);
    });

    it('throws for VIEWER without permission', async () => {
      await expect(service.listRoles('org-1', 'actor-1', viewerRole, [])).rejects.toThrow(
        AuthError,
      );
    });

    it('denies VIEWER with a protected custom role grant', async () => {
      await expect(service.listRoles('org-1', 'actor-1', viewerRole, ['organization:update']))
        .rejects.toMatchObject({ status: 403 });
    });
  });

  describe('createRole', () => {
    it('creates a custom role for OWNER', async () => {
      const role = await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'My Custom Role',
        description: 'Description',
        permissions: ['organization:read', 'contact:read'],
      });
      expect(role.name).toBe('My Custom Role');
      expect(role.permissions).toEqual(['organization:read', 'contact:read']);
      expect(role.type).toBe('CUSTOM');
    });

    it('throws for VIEWER without organization:update', async () => {
      organizations.memberships[0]!.role = viewerRole;
      await expect(
        service.createRole('org-1', 'actor-1', viewerRole, [], { name: 'X', permissions: [] }),
      ).rejects.toThrow(AuthError);
    });

    it('throws when delegating permissions actor does not have', async () => {
      organizations.memberships[0]!.role = adminRole;
      await expect(
        service.createRole('org-1', 'actor-1', adminRole, [], {
          name: 'X',
          permissions: ['ownership:transfer'],
        }),
      ).rejects.toThrow(AuthError);
    });

    it('throws on duplicate name', async () => {
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Duplicate',
        permissions: [],
      });
      await expect(
        service.createRole('org-1', 'actor-1', ownerRole, [], {
          name: 'Duplicate',
          permissions: [],
        }),
      ).rejects.toThrow(AuthError);
    });

    it('rejects a protected permission even when the built-in Owner holds it', async () => {
      await expect(service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Restricted billing', permissions: ['billing:read'],
      })).rejects.toMatchObject({ status: 403 });
      expect(audit.events).toEqual([]);
      expect(audit.identityEvents).toHaveLength(1);
    });
  });

  describe('updateRole', () => {
    it('updates a custom role for OWNER', async () => {
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Original',
        permissions: ['organization:read'],
      });
      const created = customRoles.roles.find((r) => r.name === 'Original')!;

      const updated = await service.updateRole('org-1', created.id, 'actor-1', ownerRole, [], {
        name: 'Updated',
        description: 'New description',
        permissions: ['organization:read', 'contact:read'],
      });
      expect(updated.name).toBe('Updated');
      expect(updated.description).toBe('New description');
      expect(updated.permissions).toEqual(['organization:read', 'contact:read']);
    });

    it('throws for system role', async () => {
      const systemRole = aCustomRole({
        name: 'System Role',
        type: 'SYSTEM',
        organizationId: 'org-1',
      });
      customRoles.roles.push(systemRole);

      await expect(
        service.updateRole('org-1', systemRole.id, 'actor-1', ownerRole, [], { name: 'Hacked' }),
      ).rejects.toThrow(AuthError);
    });

    it('throws on duplicate name', async () => {
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Role A',
        permissions: [],
      });
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Role B',
        permissions: [],
      });
      const roleB = customRoles.roles.find((r) => r.name === 'Role B')!;

      await expect(
        service.updateRole('org-1', roleB.id, 'actor-1', ownerRole, [], { name: 'Role A' }),
      ).rejects.toThrow(AuthError);
    });

    it('throws when delegating permissions actor does not have', async () => {
      organizations.memberships[0]!.role = adminRole;
      const created = aCustomRole({ name: 'Test', organizationId: 'org-1' });
      customRoles.roles.push(created);

      await expect(
        service.updateRole('org-1', created.id, 'actor-1', adminRole, [], {
          permissions: ['ownership:transfer'],
        }),
      ).rejects.toThrow(AuthError);
    });
  });

  describe('deleteRole', () => {
    it('deletes a custom role for OWNER', async () => {
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'ToDelete',
        permissions: [],
      });
      const created = customRoles.roles.find((r) => r.name === 'ToDelete')!;

      await service.deleteRole('org-1', created.id, 'actor-1', ownerRole, []);
      expect(customRoles.roles.find((r) => r.id === created.id)).toBeUndefined();
    });

    it('throws for system role', async () => {
      const systemRole = aCustomRole({
        name: 'System Role',
        type: 'SYSTEM',
        organizationId: 'org-1',
      });
      customRoles.roles.push(systemRole);

      await expect(
        service.deleteRole('org-1', systemRole.id, 'actor-1', ownerRole, []),
      ).rejects.toThrow(AuthError);
    });

    it('throws when role has assignments', async () => {
      await service.createRole('org-1', 'actor-1', ownerRole, [], {
        name: 'Assigned',
        permissions: [],
      });
      const created = customRoles.roles.find((r) => r.name === 'Assigned')!;
      customRoles.assignments.push({
        organizationId: 'org-1',
        roleId: created.id,
        userId: 'user-2',
        createdAt: new Date(),
      });

      await expect(
        service.deleteRole('org-1', created.id, 'actor-1', ownerRole, []),
      ).rejects.toThrow(AuthError);
    });
  });

  describe('assignUser', () => {
    it('assigns a user to a custom role', async () => {
      organizations.memberships[0]!.role = adminRole;
      organizations.addMembership('user-2', viewerRole);

      await service.createRole('org-1', 'actor-1', adminRole, [], {
        name: 'Test Role',
        permissions: ['organization:read'],
      });
      const created = customRoles.roles.find((r) => r.name === 'Test Role')!;

      await service.assignUser('org-1', created.id, 'actor-1', adminRole, [], 'user-2');
      const assignments = await customRoles.listRoleAssignments('org-1', created.id);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.userId).toBe('user-2');
    });

    it('throws for system role', async () => {
      organizations.memberships[0]!.role = adminRole;
      const systemRole = aCustomRole({
        name: 'System Role',
        type: 'SYSTEM',
        organizationId: 'org-1',
      });
      customRoles.roles.push(systemRole);

      await expect(
        service.assignUser('org-1', systemRole.id, 'actor-1', adminRole, [], 'user-2'),
      ).rejects.toThrow(AuthError);
    });

    it('throws when target is not a member', async () => {
      organizations.memberships[0]!.role = adminRole;
      await service.createRole('org-1', 'actor-1', adminRole, [], {
        name: 'Test Role',
        permissions: ['organization:read'],
      });
      const created = customRoles.roles.find((r) => r.name === 'Test Role')!;

      await expect(
        service.assignUser('org-1', created.id, 'actor-1', adminRole, [], 'non-member'),
      ).rejects.toThrow(AuthError);
    });

    it('throws when role permissions exceed actor delegation scope', async () => {
      organizations.memberships[0]!.role = adminRole;
      organizations.addMembership('user-2', viewerRole);
      const created = aCustomRole({ name: 'Escalated Role', organizationId: 'org-1' });
      customRoles.roles.push(created);
      customRoles.permissions.push({
        organizationId: 'org-1',
        roleId: created.id,
        permission: 'ownership:transfer',
      });

      await expect(
        service.assignUser('org-1', created.id, 'actor-1', adminRole, [], 'user-2'),
      ).rejects.toThrow(AuthError);
    });
  });

  describe('unassignUser', () => {
    it('unassigns a user from a custom role', async () => {
      organizations.memberships[0]!.role = adminRole;
      organizations.addMembership('user-2', viewerRole);

      await service.createRole('org-1', 'actor-1', adminRole, [], {
        name: 'Test Role',
        permissions: ['organization:read'],
      });
      const created = customRoles.roles.find((r) => r.name === 'Test Role')!;
      customRoles.assignments.push({
        organizationId: 'org-1',
        roleId: created.id,
        userId: 'user-2',
        createdAt: new Date(),
      });

      await service.unassignUser('org-1', created.id, 'actor-1', adminRole, [], 'user-2');
      const assignments = await customRoles.listRoleAssignments('org-1', created.id);
      expect(assignments).toHaveLength(0);
    });

    it('throws for system role', async () => {
      organizations.memberships[0]!.role = adminRole;
      const systemRole = aCustomRole({
        name: 'System Role',
        type: 'SYSTEM',
        organizationId: 'org-1',
      });
      customRoles.roles.push(systemRole);
      customRoles.assignments.push({
        organizationId: 'org-1',
        roleId: systemRole.id,
        userId: 'user-2',
        createdAt: new Date(),
      });

      await expect(
        service.unassignUser('org-1', systemRole.id, 'actor-1', adminRole, [], 'user-2'),
      ).rejects.toThrow(AuthError);
    });

    it('throws when unassigning self', async () => {
      organizations.memberships[0]!.role = adminRole;
      await service.createRole('org-1', 'actor-1', adminRole, [], {
        name: 'Test Role',
        permissions: ['organization:read'],
      });
      const created = customRoles.roles.find((r) => r.name === 'Test Role')!;
      customRoles.assignments.push({
        organizationId: 'org-1',
        roleId: created.id,
        userId: 'actor-1',
        createdAt: new Date(),
      });

      await expect(
        service.unassignUser('org-1', created.id, 'actor-1', adminRole, [], 'actor-1'),
      ).rejects.toThrow(AuthError);
    });
  });
});
