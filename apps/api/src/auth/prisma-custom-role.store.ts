import type { OrganizationPermission } from '@truevine/auth';
import { Inject, Injectable } from '@nestjs/common';

import type {
  CustomRoleRecord,
  NewCustomRole,
  RoleAssignmentRecord,
  UpdateCustomRole,
} from '../custom-roles/custom-role.store.js';
import type { SecurityDatabase } from './prisma-stores.js';
import { DATABASE_CLIENT } from '../tokens.js';

@Injectable()
export class PrismaCustomRoleStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async findCustomRole(organizationId: string, roleId: string): Promise<CustomRoleRecord | undefined> {
    const role = await this.prisma.customRole.findUnique({
      where: { organizationId_id: { organizationId, id: roleId } },
    });
    return role ?? undefined;
  }

  async findCustomRoleByName(organizationId: string, name: string): Promise<CustomRoleRecord | undefined> {
    const role = await this.prisma.customRole.findUnique({
      where: { organizationId_name: { organizationId, name } },
    });
    return role ?? undefined;
  }

  async listCustomRoles(organizationId: string): Promise<readonly CustomRoleRecord[]> {
    return this.prisma.customRole.findMany({ where: { organizationId } });
  }

  async createCustomRole(input: NewCustomRole): Promise<CustomRoleRecord> {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.customRole.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          type: input.type,
        },
      });
      if (input.permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: input.permissions.map((permission) => ({
            organizationId: input.organizationId,
            roleId: role.id,
            permission,
          })),
        });
      }
      return role;
    });
  }

  async updateCustomRole(
    organizationId: string,
    roleId: string,
    input: UpdateCustomRole,
  ): Promise<CustomRoleRecord> {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;

    const role = await this.prisma.customRole.update({
      where: { organizationId_id: { organizationId, id: roleId } },
      data,
    });

    if (input.permissions !== undefined) {
      await this.prisma.$transaction(async (tx) => {
        await tx.rolePermission.deleteMany({
          where: { organizationId, roleId },
        });
        if (input.permissions!.length > 0) {
          await tx.rolePermission.createMany({
            data: input.permissions!.map((permission) => ({
              organizationId,
              roleId,
              permission,
            })),
          });
        }
      });
    }

    return role;
  }

  async deleteCustomRole(organizationId: string, roleId: string): Promise<boolean> {
    const result = await this.prisma.customRole.deleteMany({
      where: { organizationId, id: roleId },
    });
    return result.count === 1;
  }

  async listRolePermissions(organizationId: string, roleId: string): Promise<readonly OrganizationPermission[]> {
    const perms = await this.prisma.rolePermission.findMany({
      where: { organizationId, roleId },
      select: { permission: true },
    });
    return perms.map((p) => p.permission as OrganizationPermission);
  }

  async setRolePermissions(
    organizationId: string,
    roleId: string,
    permissions: readonly OrganizationPermission[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({
        where: { organizationId, roleId },
      });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            organizationId,
            roleId,
            permission,
          })),
        });
      }
    });
  }

  async listRoleAssignments(organizationId: string, roleId: string): Promise<readonly RoleAssignmentRecord[]> {
    return this.prisma.roleAssignment.findMany({
      where: { organizationId, roleId },
    });
  }

  async assignUserToRole(
    organizationId: string,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    // Verify the user is a member of the organization first
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!membership) return false;

    const result = await this.prisma.roleAssignment.createMany({
      data: [{ organizationId, roleId, userId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async unassignUserFromRole(
    organizationId: string,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.prisma.roleAssignment.deleteMany({
      where: { organizationId, roleId, userId },
    });
    return result.count === 1;
  }

  async getCustomRolePermissionsForUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly OrganizationPermission[]> {
    const assignments = await this.prisma.roleAssignment.findMany({
      where: { organizationId, userId },
      select: { roleId: true },
    });
    if (assignments.length === 0) return [];

    const roleIds = assignments.map((a) => a.roleId);
    const perms = await this.prisma.rolePermission.findMany({
      where: { organizationId, roleId: { in: roleIds } },
      select: { permission: true },
    });
    return perms.map((p) => p.permission as OrganizationPermission);
  }

  async countRoleAssignments(organizationId: string, roleId: string): Promise<number> {
    return this.prisma.roleAssignment.count({
      where: { organizationId, roleId },
    });
  }
}