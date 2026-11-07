import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { PaymentIntentsService } from './payment-intents.service.js';

@Controller('organizations/:organizationId')
export class PaymentIntentsController {
  constructor(@Inject(PaymentIntentsService) private readonly service: PaymentIntentsService) {}

  @Post('payments/intents')
  @UseGuards(SessionGuard, OrganizationGuard, CsrfGuard)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('billing:update')
  create(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: unknown,
  ) {
    return this.service.createPending(context.organizationId, body);
  }
}
