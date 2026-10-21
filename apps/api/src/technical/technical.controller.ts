import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { TechnicalRateLimitGuard } from './technical-rate-limit.guard.js';
import { TechnicalService } from './technical.service.js';

/**
 * Read-only technical diagnostics routes (RBAC-010).
 *
 * All GET, so no CSRF guard: these change nothing. The guard trio on every
 * route is session, per-operator rate limit, then platform permission - rate
 * limiting before the permission check so that denied probing is counted too.
 */
@Controller('platform/technical')
export class TechnicalController {
  constructor(@Inject(TechnicalService) private readonly technical: TechnicalService) {}

  @Get('me')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.technical.operatorContext(principal.platformRole);
  }

  @Get('overview')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:read')
  overview(@CurrentPrincipal() principal: Principal) {
    return this.technical.overview(principal.userId);
  }

  @Get('providers')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:read')
  providers(@CurrentPrincipal() principal: Principal) {
    return this.technical.providers(principal.userId);
  }

  @Get('queues')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:read')
  queues(@CurrentPrincipal() principal: Principal) {
    return this.technical.queues(principal.userId);
  }

  @Get('logs')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:read')
  logs(@CurrentPrincipal() principal: Principal) {
    return this.technical.logs(principal.userId);
  }

  @Get('audit')
  @UseGuards(SessionGuard, TechnicalRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  audit(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.technical.auditTrail(principal.userId, query);
  }
}
