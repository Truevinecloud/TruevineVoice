import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ORGANIZATION_PERMISSIONS, type OrganizationPermission } from '@truevine/auth';

import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { Principal } from '../auth/principal.js';
import type { OrganizationContext } from '../auth/principal.js';

import { CustomRoleService, type CustomRoleView, type RoleAssignmentView } from './custom-role.service.js';

const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

function parseRolePermissions(value: unknown): readonly OrganizationPermission[] | undefined {
  if (value === undefined) return undefined;

  const permissions: unknown[] | undefined = Array.isArray(value) ? [...value] : undefined;
  if (
    permissions === undefined ||
    !permissions.every(
      (permission): permission is OrganizationPermission =>
        typeof permission === 'string' &&
        (ORGANIZATION_PERMISSIONS as readonly string[]).includes(permission),
    ) ||
    new Set(permissions).size !== permissions.length
  ) {
    throw new BadRequestException({
      error: {
        code: 'invalid_request',
        message: 'Permissions must be an array of distinct organization permissions.',
      },
    });
  }
  return permissions;
}


@Controller()
export class CustomRolesController {
  constructor(@Inject(CustomRoleService) private readonly customRoles: CustomRoleService) {}

  @Get('organizations/:organizationId/roles')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async listRoles(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<readonly CustomRoleView[]> {
    return this.customRoles.listRoles(
      context.organizationId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
    );
  }

  @Get('organizations/:organizationId/roles/:roleId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async getRole(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
  ): Promise<CustomRoleView> {
    return this.customRoles.getRole(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
    );
  }

  @Post('organizations/:organizationId/roles')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async createRole(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly name?: unknown; readonly description?: unknown; readonly permissions?: unknown },
  ): Promise<CustomRoleView> {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description : null;
    const permissions = parseRolePermissions(body.permissions) ?? [];
    return this.customRoles.createRole(
      context.organizationId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
      { name, description, permissions },
    );
  }

  @Patch('organizations/:organizationId/roles/:roleId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async updateRole(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
    @Body() body: { readonly name?: unknown; readonly description?: unknown; readonly permissions?: unknown },
  ): Promise<CustomRoleView> {
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const description =
      typeof body.description === 'string' || body.description === null ? body.description : undefined;
    const permissions = parseRolePermissions(body.permissions);
    return this.customRoles.updateRole(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
      { name, description, permissions },
    );
  }

  @Delete('organizations/:organizationId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async deleteRole(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.customRoles.deleteRole(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
    );
  }

  @Get('organizations/:organizationId/roles/:roleId/assignments')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('organization:update')
  async listAssignments(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
  ): Promise<readonly RoleAssignmentView[]> {
    return this.customRoles.listAssignments(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
    );
  }

  @Post('organizations/:organizationId/roles/:roleId/assignments')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('member:update')
  async assignUser(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
    @Body() body: { readonly userId?: unknown },
  ): Promise<void> {
    const targetUserId = typeof body.userId === 'string' ? body.userId : '';
    await this.customRoles.assignUser(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
      targetUserId,
    );
  }

  @Delete('organizations/:organizationId/roles/:roleId/assignments/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('member:update')
  async unassignUser(
    @CurrentOrganization() context: OrganizationContext,
    @CurrentPrincipal() principal: Principal,
    @Param('roleId') roleId: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    await this.customRoles.unassignUser(
      context.organizationId,
      roleId,
      principal.userId,
      context.role,
      [] as const satisfies readonly OrganizationPermission[],
      targetUserId,
    );
  }
}