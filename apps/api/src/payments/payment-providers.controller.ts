import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { PaymentProvidersService } from './payment-providers.service.js';

/**
 * Payment-provider configuration (MTN MoMo / Airtel Money).
 *
 * Every route is platform-scoped: no `organizationId` appears in a path, a body
 * or a query, and a tenant session cannot reach these routes at all because
 * `PlatformGuard` refuses a principal without a platform role. The permission
 * registry grants `platform:payments:*` to PLATFORM_OWNER alone, so no other
 * platform role can read a configuration status or replace a credential.
 *
 * Reads record an audit event. Writes are `PUT` so they are idempotent per
 * version, and carry `CsrfGuard` because they replace credentials.
 *
 * There is deliberately no `test-connection` route: no reviewed provider client
 * exists in this build, and a route that returns a canned success would be a
 * false statement about whether payments can be taken. The list response states
 * that connection testing is unavailable and why.
 */
@Controller('platform/payments')
export class PaymentProvidersController {
  constructor(
    @Inject(PaymentProvidersService) private readonly payments: PaymentProvidersService,
  ) {}

  @Get('me')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:payments:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return { platformRole: principal.platformRole };
  }

  @Get('providers')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:payments:read')
  list(@CurrentPrincipal() principal: Principal) {
    return this.payments.list(principal.userId);
  }

  @Get('providers/:provider/environments/:environment')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:payments:read')
  read(
    @Param('provider') provider: string,
    @Param('environment') environment: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.payments.read(principal.userId, provider, environment);
  }

  @Put('providers/:provider/environments/:environment')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:payments:configure')
  save(
    @Param('provider') provider: string,
    @Param('environment') environment: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.payments.save(principal.userId, provider, environment, body);
  }

  @Put('providers/:provider/environments/:environment/activation')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:payments:configure')
  setActive(
    @Param('provider') provider: string,
    @Param('environment') environment: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.payments.setActive(principal.userId, provider, environment, body);
  }
}
