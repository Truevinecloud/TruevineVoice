import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { AuthenticatedRequest, Principal, SupportAccessContext } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SupportAccessGuard } from './support-access.guard.js';
import { SupportAccessService } from './support-access.service.js';
import { SupportRateLimitGuard } from './support-rate-limit.guard.js';
import { SupportService } from './support.service.js';

/**
 * Support lookup and diagnostics routes (RBAC-009).
 *
 * All GET, so no CSRF guard: these change nothing. The guard trio on every
 * route is session, per-operator rate limit, then platform permission - rate
 * limiting before the permission check so that denied probing is counted too.
 */
@Controller('platform/support')
export class SupportController {
  constructor(
    @Inject(SupportService) private readonly support: SupportService,
    @Inject(SupportAccessService) private readonly access: SupportAccessService,
  ) {}

  @Post('sessions')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:support:access')
  startSupportAccess(
    @Body() body: { readonly organizationId?: unknown; readonly reasonCode?: unknown },
    @Req() request: AuthenticatedRequest,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.access.start(principal, body, Boolean(request.headers?.['x-support-access-token']));
  }

  @Post('sessions/terminate')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:support:access')
  terminateSupportAccess(
    @Headers('x-support-access-token') token: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.access.end(principal, token);
  }

  @Get('me')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.support.operatorContext(principal.platformRole);
  }

  @Get('organizations')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:read')
  searchOrganizations(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.support.searchOrganizations(principal.userId, query);
  }

  @Get('organizations/:organizationId')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:read')
  organization(
    @Param('organizationId') organizationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.support.organization(principal.userId, organizationId);
  }

  @Get('organizations/:organizationId/diagnostics')
  @UseGuards(SessionGuard, SupportRateLimitGuard, SupportAccessGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:diagnostics')
  diagnostics(
    @Param('organizationId') organizationId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ) {
    const context = request.supportAccessContext as SupportAccessContext | undefined;
    return this.support.diagnostics(
      principal.userId,
      organizationId,
      context
        ? { supportSessionId: context.id, reasonCode: context.reasonCode }
        : undefined,
    );
  }

  @Get('organizations/:organizationId/audit')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  organizationAudit(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.support.organizationAudit(principal.userId, organizationId, query);
  }

  @Get('users')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:read')
  searchUsers(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.support.searchUsers(principal.userId, query);
  }

  @Get('users/:userId')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:support:read')
  user(@Param('userId') userId: string, @CurrentPrincipal() principal: Principal) {
    return this.support.user(principal.userId, userId);
  }

  @Get('users/:userId/audit')
  @UseGuards(SessionGuard, SupportRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  userAudit(
    @Param('userId') userId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.support.userAudit(principal.userId, userId, query);
  }
}
