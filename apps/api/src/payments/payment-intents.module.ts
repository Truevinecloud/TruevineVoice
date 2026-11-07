import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { PaymentIntentsController } from './payment-intents.controller.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { PAYMENT_INTENT_STORE } from './payment-intents.tokens.js';
import { PrismaPaymentIntentStore } from './prisma-payment-intents.store.js';

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [PaymentIntentsController],
  providers: [PaymentIntentsService, { provide: PAYMENT_INTENT_STORE, useClass: PrismaPaymentIntentStore }],
})
export class PaymentIntentsModule {}
