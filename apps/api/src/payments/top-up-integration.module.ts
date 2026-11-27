import { Module } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PrismaPaymentIntentStore } from './prisma-payment-intents.store.js';
import { TopUpIntegrationController } from './top-up-integration.controller.js';
import { TopUpIntegrationService } from './top-up-integration.service.js';
import { TopUpReconciliation, type TopUpDatabase } from './top-up-reconciliation.js';

class DisabledReconciliation {
  async receive(): Promise<never> {
    throw new Error('Synthetic payments are disabled. Set W502_SYNTHETIC_PAYMENTS_ENABLED=true.');
  }
}

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [TopUpIntegrationController],
  providers: [
    TopUpIntegrationService,
    TopUpIntegrationController,
    PrismaPaymentIntentStore,
    {
      provide: TopUpReconciliation,
      useFactory: (prisma: PrismaClient) => {
        if (process.env.W502_SYNTHETIC_PAYMENTS_ENABLED === 'true') {
          const key = process.env.W502_SYNTHETIC_VERIFICATION_KEY;
          if (!key) {
            throw new Error('W502_SYNTHETIC_VERIFICATION_KEY is required for synthetic payment testing.');
          }
          return new TopUpReconciliation(prisma as unknown as TopUpDatabase, key);
        }
        return new DisabledReconciliation();
      },
      inject: [DATABASE_CLIENT],
    },
  ],
  exports: [TopUpIntegrationService],
})
export class TopUpIntegrationModule {}