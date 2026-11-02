/**
 * Compile-time proof that the payment vocabulary matches the database enums.
 *
 * The store and service use string unions so they stay independent of the
 * generated Prisma client. This file is the single place where the two
 * vocabularies meet; renaming a database enum variant stops this compiling.
 */

import type {
  PaymentProvider as PrismaPaymentProvider,
  PaymentProviderEnvironment as PrismaPaymentProviderEnvironment,
} from '@truevine/database';

import type { PaymentProvider, PaymentProviderEnvironment } from './payment-provider.contracts.js';

const _providerVocabulary: Record<PrismaPaymentProvider, PaymentProvider> = {
  MTN_MOMO: 'MTN_MOMO',
  AIRTEL_MONEY: 'AIRTEL_MONEY',
};

const _environmentVocabulary: Record<PrismaPaymentProviderEnvironment, PaymentProviderEnvironment> =
  {
    SANDBOX: 'SANDBOX',
    PRODUCTION: 'PRODUCTION',
  };

void _providerVocabulary;
void _environmentVocabulary;
