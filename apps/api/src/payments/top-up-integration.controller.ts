import { Body, Controller, Post, Req, UseGuards, Inject } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { PRINCIPAL, type AuthenticatedRequest, type Principal } from '../auth/principal.js';
import type { PrismaClient } from '@truevine/database';
import { DATABASE_CLIENT } from '../tokens.js';

import {
  assertLocalPaymentEnvironment,
  assertTestOperator,
  buildLocalPaymentSecurityConfig,
  assertDatabaseIdentity,
} from './local-payment-security.js';
import { TopUpIntegrationService } from './top-up-integration.service.js';
import type {
  CreateSyntheticTopUpInput,
  SyntheticSettlementCallback,
  SyntheticSettlementOutcome,
} from './top-up-payment.dto.js';

@UseGuards(SessionGuard)
@Controller('_test/payments')
export class TopUpIntegrationController {
  constructor(
    private readonly service: TopUpIntegrationService,
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
  ) {}

  @Post('synthetic/top-up')
  async createSyntheticTopUp(
    @Body() body: CreateSyntheticTopUpInput,
    @Req() request: AuthenticatedRequest,
  ) {
    assertLocalPaymentEnvironment(buildLocalPaymentSecurityConfig(process.env));
    await assertDatabaseIdentity(this.prisma);
    const principal = request[PRINCIPAL as keyof typeof request] as Principal | undefined;
    if (!principal) {
      throw new Error('Authenticated principal is required.');
    }
    assertTestOperator({ userId: principal.userId, roles: [principal.platformRole ?? ''] });

    return this.service.createIntentFromTopUp({
      organizationId: body.organizationId,
      actorUserId: principal.userId,
      amountMinor: BigInt(body.amountMinor),
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post('synthetic/settle')
  async settleSyntheticTopUp(
    @Body() callback: SyntheticSettlementCallback,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyntheticSettlementOutcome> {
    assertLocalPaymentEnvironment(buildLocalPaymentSecurityConfig(process.env));
    await assertDatabaseIdentity(this.prisma);
    const principal = request[PRINCIPAL as keyof typeof request] as Principal | undefined;
    if (!principal) {
      throw new Error('Authenticated principal is required.');
    }
    assertTestOperator({ userId: principal.userId, roles: [principal.platformRole ?? ''] });

    return this.service.reconcileSyntheticTopUp(callback, '');
  }
}
