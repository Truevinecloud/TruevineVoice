import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { BillingService } from './billing.service.js';

@Controller('organizations/:organizationId')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billingService: BillingService) {}

  @Get('wallet')
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('wallet:read')
  wallet(@CurrentOrganization() context: { organizationId: string }) {
    return this.billingService.wallet(context.organizationId);
  }

  @Get('wallet/transactions')
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('wallet:read')
  transactions(
    @CurrentOrganization() context: { organizationId: string },
    @Query('cursor') cursor?: string,
  ) {
    return this.billingService.transactions(context.organizationId, cursor);
  }

  @Get('billing')
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('billing:read')
  billing(@CurrentOrganization() context: { organizationId: string }) {
    return this.billingService.billing(context.organizationId);
  }

  @Patch('billing')
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('billing:update')
  save(
    @CurrentOrganization() context: { organizationId: string },
    @Body() body: unknown,
    @CurrentPrincipal() principal: { userId: string },
  ) {
    return this.billingService.saveProfile(context.organizationId, body, principal.userId);
  }

  @Post('wallet/top-ups')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('billing:update')
  topUp(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: unknown,
  ) {
    return this.billingService.requestTopUp(context.organizationId, principal.userId, body);
  }
}
