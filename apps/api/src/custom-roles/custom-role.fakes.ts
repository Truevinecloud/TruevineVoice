import type { AuditStore as AuthStoreAudit } from '../auth/auth.store.js';
import type {
  SecurityTransaction,
  SecurityStores,
  SecurityTransactionOptions,
} from '../auth/security-transaction.js';
import type {
  CustomRoleRecord,
  NewCustomRole,
  RoleAssignmentRecord,
  UpdateCustomRole,
} from './custom-role.store.js';
import type {
  AuthStore,
  MembershipChangeResult,
  MembershipRecord,
  OrganizationRecord,
} from '../auth/auth.store.js';
import type { MembershipRole } from '../auth/prisma-types.js';
import type { OrganizationPermission } from '@truevine/auth';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

let customRolesCreated = 0;

export function aCustomRole(overrides: Partial<CustomRoleRecord> = {}): Mutable<CustomRoleRecord> {
  return {
    id: `role-${customRolesCreated++}`,
    organizationId: 'org-1',
    name: 'Test Role',
    description: 'A test role',
    type: 'CUSTOM',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export class FakeCustomRoleStore {
  roles: Mutable<CustomRoleRecord>[] = [];
  permissions: Array<{
    organizationId: string;
    roleId: string;
    permission: OrganizationPermission;
  }> = [];
  assignments: Mutable<RoleAssignmentRecord>[] = [];

  async findCustomRole(
    organizationId: string,
    roleId: string,
  ): Promise<CustomRoleRecord | undefined> {
    return this.roles.find((r) => r.organizationId === organizationId && r.id === roleId);
  }

  async findCustomRoleByName(
    organizationId: string,
    name: string,
  ): Promise<CustomRoleRecord | undefined> {
    return this.roles.find((r) => r.organizationId === organizationId && r.name === name);
  }

  async listCustomRoles(organizationId: string): Promise<readonly CustomRoleRecord[]> {
    return this.roles.filter((r) => r.organizationId === organizationId);
  }

  async createCustomRole(input: NewCustomRole): Promise<CustomRoleRecord> {
    const role = aCustomRole({
      organizationId: input.organizationId,
      name: input.name,
      description: input.description,
      type: input.type,
    });
    this.roles.push(role);
    this.permissions.push(
      ...input.permissions.map((p) => ({
        organizationId: input.organizationId,
        roleId: role.id,
        permission: p,
      })),
    );
    return role;
  }

  async updateCustomRole(
    organizationId: string,
    roleId: string,
    input: UpdateCustomRole,
  ): Promise<CustomRoleRecord> {
    const index = this.roles.findIndex(
      (r) => r.organizationId === organizationId && r.id === roleId,
    );
    if (index === -1) throw new Error('Role not found');
    const role = this.roles[index]!;
    if (input.name !== undefined) role.name = input.name;
    if (input.description !== undefined) role.description = input.description;
    role.updatedAt = new Date();
    if (input.permissions !== undefined) {
      this.permissions = this.permissions.filter(
        (p) => !(p.organizationId === organizationId && p.roleId === roleId),
      );
      this.permissions.push(
        ...input.permissions.map((p) => ({ organizationId, roleId, permission: p })),
      );
    }
    return role;
  }

  async deleteCustomRole(organizationId: string, roleId: string): Promise<boolean> {
    const index = this.roles.findIndex(
      (r) => r.organizationId === organizationId && r.id === roleId,
    );
    if (index === -1) return false;
    this.roles.splice(index, 1);
    this.permissions = this.permissions.filter(
      (p) => !(p.organizationId === organizationId && p.roleId === roleId),
    );
    this.assignments = this.assignments.filter(
      (a) => !(a.organizationId === organizationId && a.roleId === roleId),
    );
    return true;
  }

  async listRolePermissions(
    organizationId: string,
    roleId: string,
  ): Promise<readonly OrganizationPermission[]> {
    return this.permissions
      .filter((p) => p.organizationId === organizationId && p.roleId === roleId)
      .map((p) => p.permission);
  }

  async setRolePermissions(
    organizationId: string,
    roleId: string,
    permissions: readonly OrganizationPermission[],
  ): Promise<void> {
    this.permissions = this.permissions.filter(
      (p) => !(p.organizationId === organizationId && p.roleId === roleId),
    );
    this.permissions.push(...permissions.map((p) => ({ organizationId, roleId, permission: p })));
  }

  async listRoleAssignments(
    organizationId: string,
    roleId: string,
  ): Promise<readonly RoleAssignmentRecord[]> {
    return this.assignments.filter(
      (a) => a.organizationId === organizationId && a.roleId === roleId,
    );
  }

  async assignUserToRole(organizationId: string, roleId: string, userId: string): Promise<boolean> {
    const exists = this.assignments.some(
      (a) => a.organizationId === organizationId && a.roleId === roleId && a.userId === userId,
    );
    if (exists) return false;
    this.assignments.push({
      organizationId,
      roleId,
      userId,
      createdAt: new Date(),
    });
    return true;
  }

  async unassignUserFromRole(
    organizationId: string,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    const index = this.assignments.findIndex(
      (a) => a.organizationId === organizationId && a.roleId === roleId && a.userId === userId,
    );
    if (index === -1) return false;
    this.assignments.splice(index, 1);
    return true;
  }

  async getCustomRolePermissionsForUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly OrganizationPermission[]> {
    const userAssignments = this.assignments.filter(
      (a) => a.organizationId === organizationId && a.userId === userId,
    );
    const roleIds = userAssignments.map((a) => a.roleId);
    return this.permissions
      .filter((p) => p.organizationId === organizationId && roleIds.includes(p.roleId))
      .map((p) => p.permission);
  }

  async countRoleAssignments(organizationId: string, roleId: string): Promise<number> {
    return this.assignments.filter(
      (a) => a.organizationId === organizationId && a.roleId === roleId,
    ).length;
  }
}

export class FakeOrganizationStoreForCustomRoles {
  organizations: Mutable<OrganizationRecord>[] = [
    { id: 'org-1', slug: 'acme', name: 'Acme', suspendedAt: null },
  ];
  memberships: Mutable<MembershipRecord>[] = [];

  async findOrganizationById(organizationId: string) {
    return this.organizations.find((o) => o.id === organizationId);
  }

  async findMembership(organizationId: string, userId: string) {
    return this.memberships.find((m) => m.organizationId === organizationId && m.userId === userId);
  }

  async setOrganizationSuspended(organizationId: string, suspended: boolean): Promise<boolean> {
    const org = this.organizations.find((o) => o.id === organizationId);
    if (!org) return false;
    org.suspendedAt = suspended ? new Date() : null;
    return true;
  }

  async updateName(organizationId: string, name: string): Promise<OrganizationRecord> {
    const org = this.organizations.find((o) => o.id === organizationId);
    if (!org) throw new Error('Organization not found');
    org.name = name;
    return org;
  }

  async listMembershipsForUser(
    userId: string,
  ): Promise<readonly (MembershipRecord & { readonly organization: OrganizationRecord })[]> {
    return this.memberships
      .filter((m) => m.userId === userId)
      .map((m) => ({
        ...m,
        organization: { id: m.organizationId, slug: 'acme', name: 'Acme', suspendedAt: null },
      }));
  }

  async listMemberships(organizationId: string): Promise<readonly MembershipRecord[]> {
    return this.memberships.filter((m) => m.organizationId === organizationId);
  }

  async changeMembershipRole(
    organizationId: string,
    userId: string,
    role: MembershipRole,
  ): Promise<MembershipChangeResult> {
    const membership = this.memberships.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (!membership) return { ok: false, reason: 'not_found' };
    if (membership.role === 'OWNER') return { ok: false, reason: 'last_owner' };
    membership.role = role;
    return { ok: true };
  }

  async removeMembership(organizationId: string, userId: string): Promise<MembershipChangeResult> {
    const index = this.memberships.findIndex(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (index === -1) return { ok: false, reason: 'not_found' };
    this.memberships.splice(index, 1);
    return { ok: true };
  }

  async transferOwnership(
    _organizationId: string,
    _expectedCurrentOwnerId: string,
    _newOwnerId: string,
  ): Promise<MembershipChangeResult> {
    return { ok: true };
  }

  async readCustomOrganizationGrants(_organizationId: string): Promise<readonly string[]> {
    return [];
  }

  async findInvitationState(_organizationId: string, _id: string) {
    return undefined;
  }

  async listInvitations(
    _organizationId: string,
  ): Promise<readonly import('../auth/auth.store.js').InvitationRecord[]> {
    return [];
  }

  async findOutstandingInvitationByEmail(
    _organizationId: string,
    _email: string,
  ): Promise<readonly import('../auth/auth.store.js').InvitationRecord[]> {
    return [];
  }

  async findInvitationByTokenHash(
    _tokenHash: string,
  ): Promise<import('../auth/auth.store.js').InvitationRecord | undefined> {
    return undefined;
  }

  async createInvitation(
    _invitation: import('../auth/auth.store.js').NewInvitation,
  ): Promise<import('../auth/auth.store.js').InvitationRecord> {
    return {
      organizationId: 'org-1',
      id: 'invitation-1',
      email: 'invitee@example.invalid',
      role: 'VIEWER' as MembershipRole,
      tokenHash: 'token-hash',
      invitedByUserId: 'actor-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-08T00:00:00Z'),
      acceptedAt: null,
      revokedAt: null,
    };
  }

  async revokeInvitation(
    _organizationId: string,
    _invitationId: string,
    _now: Date,
  ): Promise<boolean> {
    return false;
  }

  async acceptInvitation(
    _tokenHash: string,
    _userId: string,
    _now: Date,
  ): Promise<{ readonly ok: boolean }> {
    return { ok: false };
  }

  async activateInvitation(
    _tokenHash: string,
    _newUser: import('../auth/auth.store.js').InvitationActivationUser,
    _now: Date,
  ) {
    return { ok: false as const, reason: 'invalid' as const };
  }

  addMembership(userId: string, role: MembershipRole) {
    this.memberships.push({ organizationId: 'org-1', userId, role, createdAt: new Date() });
  }
}

export class FakeAuditStoreForCustomRoles {
  failure?: Error;
  identityFailure?: Error;
  identityEvents: Array<Parameters<AuthStoreAudit['recordIdentity']>[0]> = [];
  events: Array<{
    organizationId: string;
    actorUserId: string;
    action: string;
    scope: 'ORGANIZATION' | 'PLATFORM';
    outcome: 'SUCCESS' | 'DENIED';
    metadata: Record<string, unknown>;
  }> = [];

  async record(event: {
    organizationId: string;
    actorUserId: string;
    action: string;
    scope: 'ORGANIZATION' | 'PLATFORM';
    outcome: 'SUCCESS' | 'DENIED';
    metadata: Record<string, unknown>;
  }) {
    if (this.failure) throw this.failure;
    this.events.push(event);
  }

  async recordIdentity(event: Parameters<AuthStoreAudit['recordIdentity']>[0]) {
    if (this.identityFailure) throw this.identityFailure;
    this.identityEvents.push(event);
  }

  getEvents() {
    return this.events;
  }
}

export class FakeSecurityTransactionForCustomRoles implements SecurityTransaction {
  beforeOrganizationLock?: () => void;
  options?: SecurityTransactionOptions;
  active = false;

  constructor(
    private readonly customRoles: FakeCustomRoleStore,
    private readonly organizations: FakeOrganizationStoreForCustomRoles,
    private readonly audit: FakeAuditStoreForCustomRoles,
    private readonly auth: AuthStore,
  ) {}

  async run<T>(
    work: (stores: SecurityStores) => Promise<T>,
    options?: SecurityTransactionOptions,
  ): Promise<T> {
    this.options = options;
    const scopedRoles = new FakeCustomRoleStore();
    const scopedAudit = new FakeAuditStoreForCustomRoles();
    scopedAudit.failure = this.audit.failure;
    this.active = true;
    try {
      const result = await work({
        auth: this.auth,
        organizations: this.organizations,
        audit: scopedAudit,
        customRoles: scopedRoles,
        lockUser: async () => {},
        lockOrganization: async () => {
          this.beforeOrganizationLock?.();
          Object.assign(scopedRoles, structuredClone(this.customRoles));
        },
      });
      Object.assign(this.customRoles, scopedRoles);
      this.audit.events.push(...scopedAudit.events);
      return result;
    } finally {
      this.active = false;
    }
  }
}
