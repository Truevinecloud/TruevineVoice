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
import { PlatformAdminService } from './platform-admin.service.js';

@Controller('platform/admin')
export class PlatformAdminController {
  constructor(@Inject(PlatformAdminService) private readonly admin: PlatformAdminService) {}

  @Get('me')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:admin:manage')
  operatorContext(@CurrentPrincipal() principal: Principal) {
    return this.admin.operatorContext(principal.platformRole);
  }

  @Get('roles')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:admin:manage')
  listRoles(@CurrentPrincipal() principal: Principal) {
    return this.admin.listAssignments(principal.userId);
  }

  @Post('roles')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:admin:manage')
  grantRole(
    @Body() body: { readonly userId?: unknown; readonly role?: unknown },
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.grantRole(principal.userId, body.userId, body.role);
  }

  @Post('roles/:userId/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:admin:manage')
  revokeRole(@Param('userId') userId: string, @CurrentPrincipal() principal: Principal) {
    return this.admin.revokeRole(principal.userId, userId);
  }
}
