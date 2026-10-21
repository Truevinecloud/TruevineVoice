import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AuditRateLimitGuard } from './audit-rate-limit.guard.js';
import { AuditService } from './audit.service.js';

/**
 * Read-only Admin / Auditor routes (RBAC-011).
 *
 * All GET, so no CSRF guard: these change nothing. The guard trio on every
 * route is session, per-operator rate limit, then platform permission - rate
 * limiting before the permission check so that denied probing is counted too.
 *
 * There is deliberately no POST, PUT, PATCH or DELETE in this controller. The
 * auditor's contract that it "cannot mutate" is enforced here by the absence of
 * any route that would let it, and is asserted in the route-guard tests.
 */
@Controller('platform/audit')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get('me')
  @UseGuards(SessionGuard, AuditRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.audit.operatorContext(principal.platformRole);
  }

  @Get('overview')
  @UseGuards(SessionGuard, AuditRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  overview(@CurrentPrincipal() principal: Principal) {
    return this.audit.overview(principal.userId);
  }

  @Get('organizations')
  @UseGuards(SessionGuard, AuditRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:tenant:read')
  organizations(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audit.organizations(principal.userId, query);
  }

  @Get('audit')
  @UseGuards(SessionGuard, AuditRateLimitGuard, PlatformGuard)
  @RequirePlatformPermission('platform:audit:read')
  auditTrail(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audit.auditTrail(principal.userId, query);
  }
}
