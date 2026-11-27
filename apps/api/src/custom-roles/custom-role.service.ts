import { auditReason } from '@truevine/auth';
import { auditDigest, mutationAudit } from '../auth/sensitive-audit.js';
import {
  SECURITY_TRANSACTION,
  type SecurityStores,
  type SecurityTransaction,
} from '../auth/security-transaction.js';
import { Inject, Injectable } from '@nestjs/common';
import {
  AuthError,
  can,
  cannotDelegate,
  memberNotFound,
  roleAssigned,
  roleNameConflict,
  roleNotFound,
  selfUnassignment,
  systemRoleProtected,
  assignmentFailed,
  assignmentNotFound,
  type OrganizationPermission,
  type OrganizationRole,
} from '@truevine/auth';

import type { CustomRoleStore } from './tokens.js';
import { CUSTOM_ROLE_STORE } from './tokens.js';
import type { AuditStore, OrganizationStore } from '../auth/auth.store.js';
import { AUDIT_STORE, ORGANIZATION_STORE } from '../auth/tokens.js';
import type { CustomRoleRecord } from './custom-role.store.js';

import {
  canManageCustomRoles,
  canAssignCustomRoles,
  delegationScope,
  canDelegateCustomRole,
  isSystemRole,
} from './custom-role-authorization.js';

export interface CustomRoleView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: 'SYSTEM' | 'CUSTOM';
  readonly permissions: readonly OrganizationPermission[];
  readonly assignedUserCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleAssignmentView {
  readonly userId: string;
  readonly email: string;
  readonly assignedAt: string;
}

interface CustomRoleActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly builtInRole: OrganizationRole | null;
  readonly customRolePermissions: readonly OrganizationPermission[];
}

function makeActor(
  organizationId: string,
  userId: string,
  builtInRole: OrganizationRole | null,
  customRolePermissions: readonly OrganizationPermission[],
): CustomRoleActor {
  return { organizationId, userId, builtInRole, customRolePermissions };
}

const CUSTOM_ROLE_DENIAL_CODES = new Set([
  'cannot_delegate_beyond_own_authority',
  'role_not_found',
  'system_role_protected',
  'member_not_found',
  'self_unassignment',
  'role_name_conflict',
  'role_assigned',
  'assignment_failed',
  'assignment_not_found',
]);

@Injectable()
export class CustomRoleService {
  constructor(
    @Inject(CUSTOM_ROLE_STORE) private readonly customRoleStore: CustomRoleStore,
    @Inject(ORGANIZATION_STORE) private readonly organizationStore: OrganizationStore,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
    @Inject(SECURITY_TRANSACTION) private readonly transactions: SecurityTransaction,
  ) {}

  async listRoles(
    organizationId: string,
    userId: string,
    builtInRole: OrganizationRole | null,
    customRolePermissions: readonly OrganizationPermission[],
  ): Promise<readonly CustomRoleView[]> {
    const actor = makeActor(organizationId, userId, builtInRole, customRolePermissions);
    const authz = canManageCustomRoles(actor);
    if (!authz.allowed) throw cannotDelegate();

    const roles = await this.customRoleStore.listCustomRoles(organizationId);
    return Promise.all(
      roles.map(async (role) => {
        const permissions = await this.customRoleStore.listRolePermissions(organizationId, role.id);
        const assignedUserCount = await this.customRoleStore.countRoleAssignments(
          organizationId,
          role.id,
        );
        return {
          id: role.id,
          name: role.name,
          description: role.description,
          type: role.type,
          permissions,
          assignedUserCount,
          createdAt: role.createdAt.toISOString(),
          updatedAt: role.updatedAt.toISOString(),
        };
      }),
    );
  }

  async getRole(
    organizationId: string,
    roleId: string,
    userId: string,
    builtInRole: OrganizationRole | null,
    customRolePermissions: readonly OrganizationPermission[],
  ): Promise<CustomRoleView> {
    const actor = makeActor(organizationId, userId, builtInRole, customRolePermissions);
    const authz = canManageCustomRoles(actor);
    if (!authz.allowed) throw cannotDelegate();

    const role = await this.customRoleStore.findCustomRole(organizationId, roleId);
    if (!role) throw roleNotFound();

    const permissions = await this.customRoleStore.listRolePermissions(organizationId, role.id);
    const assignedUserCount = await this.customRoleStore.countRoleAssignments(
      organizationId,
      role.id,
    );
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      type: role.type,
      permissions,
      assignedUserCount,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  }

  async createRole(
    organizationId: string,
    userId: string,
    _builtInRole: OrganizationRole | null,
    _customRolePermissions: readonly OrganizationPermission[],
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly permissions: readonly OrganizationPermission[];
    },
    reason?: unknown,
  ): Promise<CustomRoleView> {
    return this.mutate(
      'custom_role.created',
      organizationId,
      userId,
      canManageCustomRoles,
      async (stores, actor) => {
        if (!delegationScope(actor, input.permissions).allowed) throw cannotDelegate();
        if (await stores.customRoles.findCustomRoleByName(organizationId, input.name))
          throw roleNameConflict();

        const audit = auditReason(reason, 'custom_role_creation');
        const role = await stores.customRoles.createCustomRole({
          organizationId,
          name: input.name,
          description: input.description ?? null,
          type: 'CUSTOM',
          permissions: input.permissions,
          createdByUserId: userId,
        });
        const permissions = await stores.customRoles.listRolePermissions(organizationId, role.id);
        await this.audit(stores, organizationId, userId, 'custom_role.created', {
          organizationId,
          roleId: role.id,
          ...mutationAudit({
            targetType: 'custom_role',
            targetId: role.id,
            before: null,
            change: { name: role.name, permissions },
            after: this.roleAuditState(role, permissions),
            ...audit,
          }),
        });
        return this.roleView(role, permissions, 0);
      },
    );
  }

  async updateRole(
    organizationId: string,
    roleId: string,
    userId: string,
    _builtInRole: OrganizationRole | null,
    _customRolePermissions: readonly OrganizationPermission[],
    input: {
      readonly name?: string;
      readonly description?: string | null;
      readonly permissions?: readonly OrganizationPermission[];
    },
    reason?: unknown,
  ): Promise<CustomRoleView> {
    return this.mutate(
      'custom_role.updated',
      organizationId,
      userId,
      canManageCustomRoles,
      async (stores, actor) => {
        const { role, permissions } = await this.mutableRole(stores, actor, roleId);
        if (input.permissions !== undefined && !delegationScope(actor, input.permissions).allowed) {
          throw cannotDelegate();
        }
        if (
          input.name !== undefined &&
          input.name !== role.name &&
          (await stores.customRoles.findCustomRoleByName(organizationId, input.name))
        ) {
          throw roleNameConflict();
        }

        const audit = auditReason(reason, 'custom_role_update');
        const before = this.roleAuditState(role, permissions);
        const patch = {
          name: input.name !== role.name ? input.name : undefined,
          description: input.description !== role.description ? input.description : undefined,
          permissions:
            input.permissions !== undefined &&
            JSON.stringify([...input.permissions].sort()) !== JSON.stringify(before.permissions)
              ? input.permissions
              : undefined,
        };
        if (Object.values(patch).every((value) => value === undefined)) {
          const count = await stores.customRoles.countRoleAssignments(organizationId, roleId);
          return this.roleView(role, permissions, count);
        }

        const updated = await stores.customRoles.updateCustomRole(organizationId, roleId, patch);
        const updatedPermissions = await stores.customRoles.listRolePermissions(
          organizationId,
          roleId,
        );
        const assignedCount = await stores.customRoles.countRoleAssignments(organizationId, roleId);
        const after = this.roleAuditState(updated, updatedPermissions);
        await this.audit(stores, organizationId, userId, 'custom_role.updated', {
          organizationId,
          roleId,
          ...mutationAudit({
            targetType: 'custom_role',
            targetId: roleId,
            before,
            change: {
              ...(patch.name !== undefined ? { name: after.name } : {}),
              ...(patch.description !== undefined
                ? { descriptionDigest: after.descriptionDigest }
                : {}),
              ...(patch.permissions !== undefined ? { permissions: after.permissions } : {}),
            },
            after,
            ...audit,
          }),
        });
        return this.roleView(updated, updatedPermissions, assignedCount);
      },
    );
  }

  async deleteRole(
    organizationId: string,
    roleId: string,
    userId: string,
    _builtInRole: OrganizationRole | null,
    _customRolePermissions: readonly OrganizationPermission[],
    reason?: unknown,
  ): Promise<void> {
    await this.mutate(
      'custom_role.deleted',
      organizationId,
      userId,
      canManageCustomRoles,
      async (stores, actor) => {
        const { role, permissions } = await this.mutableRole(stores, actor, roleId);
        if ((await stores.customRoles.countRoleAssignments(organizationId, roleId)) > 0)
          throw roleAssigned();

        const audit = auditReason(reason, 'custom_role_deletion');
        if (!(await stores.customRoles.deleteCustomRole(organizationId, roleId)))
          throw roleNotFound();
        await this.audit(stores, organizationId, userId, 'custom_role.deleted', {
          organizationId,
          roleId,
          ...mutationAudit({
            targetType: 'custom_role',
            targetId: roleId,
            before: this.roleAuditState(role, permissions),
            change: { deleted: true },
            after: null,
            ...audit,
          }),
        });
      },
    );
  }

  async listAssignments(
    organizationId: string,
    roleId: string,
    userId: string,
    builtInRole: OrganizationRole | null,
    customRolePermissions: readonly OrganizationPermission[],
  ): Promise<readonly RoleAssignmentView[]> {
    const actor = makeActor(organizationId, userId, builtInRole, customRolePermissions);
    const authz = canManageCustomRoles(actor);
    if (!authz.allowed) throw cannotDelegate();

    const existing = await this.customRoleStore.findCustomRole(organizationId, roleId);
    if (!existing) throw roleNotFound();

    const assignments = await this.customRoleStore.listRoleAssignments(organizationId, roleId);
    return Promise.all(
      assignments.map(async (assignment) => {
        const membership = await this.organizationStore.findMembership(
          organizationId,
          assignment.userId,
        );
        return {
          userId: assignment.userId,
          email: membership?.userId ?? assignment.userId,
          assignedAt: assignment.createdAt.toISOString(),
        };
      }),
    );
  }

  async assignUser(
    organizationId: string,
    roleId: string,
    userId: string,
    _builtInRole: OrganizationRole | null,
    _customRolePermissions: readonly OrganizationPermission[],
    targetUserId: string,
    reason?: unknown,
  ): Promise<void> {
    await this.mutate(
      'custom_role.assigned',
      organizationId,
      userId,
      canAssignCustomRoles,
      async (stores, actor) => {
        const { permissions } = await this.mutableRole(stores, actor, roleId);
        if (!canDelegateCustomRole(actor, permissions).allowed) throw cannotDelegate();
        if (!(await stores.organizations.findMembership(organizationId, targetUserId)))
          throw memberNotFound();

        const audit = auditReason(reason, 'custom_role_assignment');
        if (!(await stores.customRoles.assignUserToRole(organizationId, roleId, targetUserId)))
          throw assignmentFailed();
        await this.audit(stores, organizationId, userId, 'custom_role.assigned', {
          organizationId,
          roleId,
          targetUserId,
          ...mutationAudit({
            targetType: 'role_assignment',
            targetId: targetUserId,
            before: null,
            change: { roleId },
            after: { roleId },
            ...audit,
          }),
        });
      },
    );
  }

  async unassignUser(
    organizationId: string,
    roleId: string,
    userId: string,
    _builtInRole: OrganizationRole | null,
    _customRolePermissions: readonly OrganizationPermission[],
    targetUserId: string,
    reason?: unknown,
  ): Promise<void> {
    await this.mutate(
      'custom_role.unassigned',
      organizationId,
      userId,
      canAssignCustomRoles,
      async (stores, actor) => {
        await this.mutableRole(stores, actor, roleId);
        if (targetUserId === userId) throw selfUnassignment();
        if (!(await stores.organizations.findMembership(organizationId, targetUserId)))
          throw assignmentNotFound();

        const audit = auditReason(reason, 'custom_role_unassignment');
        if (!(await stores.customRoles.unassignUserFromRole(organizationId, roleId, targetUserId)))
          throw assignmentNotFound();
        await this.audit(stores, organizationId, userId, 'custom_role.unassigned', {
          organizationId,
          roleId,
          targetUserId,
          ...mutationAudit({
            targetType: 'role_assignment',
            targetId: targetUserId,
            before: { roleId },
            change: { removed: true },
            after: null,
            ...audit,
          }),
        });
      },
    );
  }

  private async mutate<T>(
    action: string,
    organizationId: string,
    userId: string,
    authorize: typeof canManageCustomRoles,
    work: (stores: SecurityStores, actor: CustomRoleActor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.run(
        async (stores) => {
          await stores.lockOrganization(organizationId);
          await stores.lockUser(userId);
          const organization = await stores.organizations.findOrganizationById(organizationId);
          const membership = await stores.organizations.findMembership(organizationId, userId);
          const user = await stores.auth.findUserById(userId);
          if (
            !organization ||
            organization.suspendedAt ||
            !membership ||
            user?.status !== 'ACTIVE'
          ) {
            throw cannotDelegate();
          }

          const actor = makeActor(organizationId, userId, membership.role, []);
          if (!authorize(actor).allowed) throw cannotDelegate();
          return work(stores, actor);
        },
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error) {
      await this.auditDenial(action, organizationId, userId, error);
      throw error;
    }
  }

  private async auditDenial(
    action: string,
    organizationId: string,
    actorUserId: string,
    error: unknown,
  ) {
    if (!(error instanceof AuthError) || !CUSTOM_ROLE_DENIAL_CODES.has(error.code)) return;
    // The identity trail does not require a tenant FK. Only the path digest and
    // server-defined codes are retained, even when the target belongs elsewhere.
    try {
      await this.auditStore.recordIdentity({
        actorUserId,
        action: 'authorization.denied',
        outcome: 'DENIED',
        metadata: {
          operation: action,
          reason: error.code,
          attemptedOrganizationDigest: auditDigest(organizationId),
        },
      });
    } catch {
      process.stderr.write('[authorization] Custom-role denial audit unavailable.\n');
    }
  }

  private async mutableRole(stores: SecurityStores, actor: CustomRoleActor, roleId: string) {
    const role = await stores.customRoles.findCustomRole(actor.organizationId, roleId);
    if (!role) throw roleNotFound();
    if (isSystemRole(role)) throw systemRoleProtected();
    const permissions = await stores.customRoles.listRolePermissions(actor.organizationId, roleId);
    // Existing protected entries stay inert, but an authorized built-in owner can remove them.
    const roleAuthority = actor.builtInRole;
    if (!roleAuthority || !permissions.every((permission) => can(roleAuthority, permission))) {
      throw cannotDelegate();
    }
    return { role, permissions };
  }

  private roleAuditState(role: CustomRoleRecord, permissions: readonly OrganizationPermission[]) {
    return {
      name: role.name,
      descriptionDigest: role.description === null ? null : auditDigest(role.description),
      permissions: [...permissions].sort(),
    };
  }

  private roleView(
    role: CustomRoleRecord,
    permissions: readonly OrganizationPermission[],
    assignedUserCount: number,
  ): CustomRoleView {
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      type: role.type,
      permissions,
      assignedUserCount,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  }

  private async audit(
    stores: SecurityStores,
    organizationId: string,
    actorUserId: string,
    action: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await stores.audit.record({
      organizationId,
      actorUserId,
      action,
      scope: 'ORGANIZATION',
      outcome: 'SUCCESS',
      metadata,
    });
  }
}
