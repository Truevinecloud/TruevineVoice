/**
 * Organization profile, membership, invitations and ownership.
 *
 * Every route here declares the permission it needs with
 * `@RequireOrganizationPermission`. That declaration is what the guard reads;
 * there is no inline permission check anywhere in this controller, because an
 * inline check is one somebody forgets to update when the route changes.
 *
 * The organization id always comes from the path and is never read from a body
 * or query field. The guard has already proved the caller holds a membership in
 * it before any handler runs.
 */

import {
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

import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  ORGANIZATION_ROLES,
  ORGANIZATION_ROLE_PERMISSIONS,
  type OrganizationRole,
} from '@truevine/auth';

import {
  OrganizationsService,
  type InvitationView,
  type MemberView,
  type MembershipSummary,
  type OrganizationView,
} from './organizations.service.js';

/** Rejects a role value the registry does not define, rather than casting it. */
function parseRole(value: unknown): OrganizationRole {
  if (typeof value !== 'string' || !(ORGANIZATION_ROLES as readonly string[]).includes(value)) {
    throw new Error('A valid organization role is required.');
  }

  return value as OrganizationRole;
}

/**
 * Guards applied to every organization-scoped route.
 *
 * `CsrfGuard` is part of this list, not an afterthought. Without it every
 * mutation below - rename, role change, member removal, invitation, ownership
 * transfer - is forgeable from a same-site context, because the session cookie
 * alone is the credential. `SameSite=Lax` blocks most cross-site POSTs but not
 * all of them, and it is not a control this codebase relies on alone.
 */
const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

@Controller()
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  /**
   * `GET /me`
   *
   * No organization guard: the point of this route is to tell the client which
   * organizations the caller may act in, which cannot be answered until that is
   * known. Every organization-scoped route it leads to is guarded in turn.
   */
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentPrincipal() principal: { userId: string; platformRole: string | null }) {
    const memberships = await this.membershipSummaries(principal.userId);

    return this.organizations.describeCaller(principal.userId, principal.platformRole, memberships);
  }

  /** `GET /organizations/:organizationId` */
  @Get('organizations/:organizationId')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('organization:read')
  async getProfile(
    @CurrentOrganization() context: { organizationId: string },
  ): Promise<OrganizationView> {
    return this.organizations.getProfile(context.organizationId);
  }

  /** `PATCH /organizations/:organizationId` */
  @Patch('organizations/:organizationId')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('organization:update')
  async updateProfile(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: { readonly name?: unknown },
  ): Promise<OrganizationView> {
    return this.organizations.updateProfile(
      context.organizationId,
      principal.userId,
      typeof body.name === 'string' ? body.name : '',
    );
  }

  /** `GET /organizations/:organizationId/members` */
  @Get('organizations/:organizationId/members')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('member:read')
  async listMembers(
    @CurrentOrganization() context: { organizationId: string },
  ): Promise<readonly MemberView[]> {
    return this.organizations.listMembers(context.organizationId);
  }

  /**
   * `PATCH /organizations/:organizationId/members/:userId`
   *
   * The target user id comes from the path, and the organization from the same
   * validated path segment. A forged `userId` from another tenant is not a
   * privilege: it is just an id, and the delegation rule applies to it exactly as
   * it would to the caller's own colleague.
   */
  @Patch('organizations/:organizationId/members/:userId')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('member:update')
  async changeMemberRole(
    @CurrentOrganization() context: { organizationId: string; role: OrganizationRole },
    @CurrentPrincipal() principal: { userId: string },
    @Param('userId') userId: string,
    @Body() body: { readonly role?: unknown },
  ): Promise<{ readonly ok: true }> {
    await this.organizations.changeMemberRole(
      context.organizationId,
      { userId: principal.userId, role: context.role },
      userId,
      parseRole(body.role),
    );

    return { ok: true };
  }

  /** `DELETE /organizations/:organizationId/members/:userId` */
  @Delete('organizations/:organizationId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...Protected)
  @RequireOrganizationPermission('member:remove')
  async removeMember(
    @CurrentOrganization() context: { organizationId: string; role: OrganizationRole },
    @CurrentPrincipal() principal: { userId: string },
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.organizations.removeMember(
      context.organizationId,
      { userId: principal.userId, role: context.role },
      userId,
    );
  }

  /** `GET /organizations/:organizationId/invitations` */
  @Get('organizations/:organizationId/invitations')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('invitation:read')
  async listInvitations(
    @CurrentOrganization() context: { organizationId: string },
  ): Promise<readonly InvitationView[]> {
    return this.organizations.listInvitations(context.organizationId);
  }

  /** `POST /organizations/:organizationId/invitations` */
  @Post('organizations/:organizationId/invitations')
  @UseGuards(...Protected)
  @RequireOrganizationPermission('member:invite')
  async invite(
    @CurrentOrganization() context: { organizationId: string; role: OrganizationRole },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: { readonly email?: unknown; readonly role?: unknown },
  ): Promise<InvitationView> {
    return this.organizations.invite(
      context.organizationId,
      { userId: principal.userId, role: context.role },
      typeof body.email === 'string' ? body.email : '',
      parseRole(body.role),
    );
  }

  /** `DELETE /organizations/:organizationId/invitations/:invitationId` */
  @Delete('organizations/:organizationId/invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...Protected)
  @RequireOrganizationPermission('invitation:revoke')
  async revokeInvitation(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.organizations.revokeInvitation(
      context.organizationId,
      principal.userId,
      invitationId,
    );
  }

  /**
   * `POST /invitations/accept`
   *
   * Needs a session but no membership: the caller is by definition not yet a
   * member, which is the only reason this route exists.
   */
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  // Needs a session but no membership: the caller is by definition not yet a
  // member, which is the only reason this route exists. `CsrfGuard` is still
  // required - a cookie-authenticated mutation needs it wherever it lives.
  @UseGuards(SessionGuard, CsrfGuard)
  async acceptInvitation(
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: { readonly token?: unknown },
  ): Promise<{ readonly organizationId: string }> {
    return this.organizations.acceptInvitation(
      principal.userId,
      typeof body.token === 'string' ? body.token : '',
    );
  }

  /** `POST /organizations/:organizationId/ownership/transfer` */
  @Post('organizations/:organizationId/ownership/transfer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(...Protected)
  @RequireOrganizationPermission('ownership:transfer')
  async transferOwnership(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: { readonly newOwnerId?: unknown },
  ): Promise<{ readonly ok: true }> {
    await this.organizations.transferOwnership(
      context.organizationId,
      principal.userId,
      typeof body.newOwnerId === 'string' ? body.newOwnerId : '',
    );

    return { ok: true };
  }

  /** Builds the membership list `GET /me` returns, including each role's permissions. */
  private async membershipSummaries(userId: string): Promise<readonly MembershipSummary[]> {
    const memberships = await this.organizations.membershipsFor(userId);

    return memberships.map((membership) => ({
      organizationId: membership.organization.id,
      organizationSlug: membership.organization.slug,
      organizationName: membership.organization.name,
      // The database enum and the registry role are the same vocabulary; the
      // mapping is explicit so a future divergence fails to compile rather than
      // silently looking up `undefined` permissions.
      role: membership.role as OrganizationRole,
      // Sent explicitly so the client's navigation matches what the server will
      // actually permit. The server never trusts these values - they are for
      // presentation only, and every request is re-checked by the guard.
      permissions: ORGANIZATION_ROLE_PERMISSIONS[membership.role as OrganizationRole],
    }));
  }
}
