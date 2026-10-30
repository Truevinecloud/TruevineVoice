import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { AesPaymentCredentialCipher, type CredentialCipher } from './credential-cipher.js';
import { PaymentProvidersController } from './payment-providers.controller.js';
import { PaymentProvidersService } from './payment-providers.service.js';
import { PrismaPaymentProviderStore } from './prisma-payment-providers.store.js';
import { PAYMENT_CREDENTIAL_CIPHER, PAYMENT_PROVIDER_STORE } from './tokens.js';

/**
 * Payment-provider credential configuration (MTN MoMo / Airtel Money).
 *
 * The cipher is built once at start-up from the validated API configuration.
 * When `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` is absent - permitted only outside
 * production - the cipher reports itself unavailable and writes fail with 503
 * rather than falling back to a default key.
 */
@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [PaymentProvidersController],
  providers: [
    PaymentProvidersService,
    { provide: PAYMENT_PROVIDER_STORE, useClass: PrismaPaymentProviderStore },
    {
      provide: PAYMENT_CREDENTIAL_CIPHER,
      useFactory: (config: ApiConfig): CredentialCipher =>
        new AesPaymentCredentialCipher(config.paymentCredentialEncryptionKey),
      inject: [APP_CONFIG],
    },
  ],
})
export class PaymentProvidersModule {}
