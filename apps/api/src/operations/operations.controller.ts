import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OperationsService } from './operations.service.js';

@Controller('platform/operations')
export class OperationsController {
  constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @Get('me')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:operations:read')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.operations.operatorContext(principal.platformRole);
  }

  @Get('organizations')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:tenant:read')
  listOrganizations() {
    return this.operations.listOrganizations();
  }

  @Get('campaigns')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:operations:read')
  listCampaigns() {
    return this.operations.listCampaigns();
  }

  @Get('health')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:operations:read')
  health() {
    return this.operations.healthReport();
  }

  @Post('organizations/:organizationId/campaigns/:campaignId/emergency-stop')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:operations:write')
  emergencyStop(
    @Param('organizationId') organizationId: string,
    @Param('campaignId') campaignId: string,
    @Body() body: { readonly reasonCode?: unknown; readonly justification?: unknown },
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.operations.emergencyStop(
      organizationId,
      campaignId,
      principal.userId,
      body.reasonCode,
      body.justification,
    );
  }
}
