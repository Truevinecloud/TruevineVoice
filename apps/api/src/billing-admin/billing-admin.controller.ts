import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { BillingAdminService } from './billing-admin.service.js';

@Controller('platform/billing')
export class BillingAdminController {
  constructor(@Inject(BillingAdminService) private readonly billing: BillingAdminService) {}

  @Get('me')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.billing.operatorContext(principal.platformRole);
  }

  @Get('overview')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  overview(@CurrentPrincipal() principal: Principal) {
    return this.billing.overview(principal.userId);
  }

  @Get('organizations')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  organizations(@Query() query: Record<string, string | undefined>, @CurrentPrincipal() principal: Principal) {
    return this.billing.listOrganizations(principal.userId, query ?? {});
  }

  @Get('organizations/:organizationId')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  organization(@Param('organizationId') organizationId: string, @CurrentPrincipal() principal: Principal) {
    return this.billing.organization(principal.userId, organizationId);
  }

  @Get('organizations/:organizationId/wallet/transactions')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  walletTransactions(
    @Param('organizationId') organizationId: string,
    @Query('cursor') cursor: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.walletEntries(principal.userId, organizationId, cursor);
  }

  @Get('payments')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  payments(
    @Query('organizationId') organizationId: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.payments(principal.userId, organizationId);
  }

  @Get('reconciliation')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  reconciliation(@CurrentPrincipal() principal: Principal) {
    return this.billing.reconciliation(principal.userId);
  }

  @Get('audit')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:billing:read')
  audit(
    @Query() query: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.auditTrail(principal.userId, query ?? {});
  }

  @Post('organizations/:organizationId/wallet/adjustments')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:billing:refund')
  adjustWallet(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.adjustWallet(principal.userId, organizationId, body);
  }
}
