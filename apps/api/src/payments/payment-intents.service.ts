import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import type { PaymentIntentStore } from './payment-intents.store.js';
import { PAYMENT_INTENT_STORE } from './payment-intents.tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'invalid_payment_intent', message } });
}

@Injectable()
export class PaymentIntentsService {
  constructor(@Inject(PAYMENT_INTENT_STORE) private readonly store: PaymentIntentStore) {}

  async createPending(organizationId: string, input: unknown) {
    if (!input || typeof input !== 'object') invalid('Payment details are required.');
    const body = input as Record<string, unknown>;
    if (body.purpose !== 'WALLET_TOP_UP') invalid('Only wallet top-up payment intents are supported.');
    if (body.currency !== 'UGX') invalid('Currency must be UGX.');
    if (typeof body.amountMinor !== 'string' || !/^[1-9][0-9]{0,18}$/.test(body.amountMinor))
      invalid('Enter a positive whole UGX amount as text.');
    const amountMinor = BigInt(body.amountMinor);
    if (amountMinor > 9223372036854775807n) invalid('Amount exceeds the supported limit.');
    if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey))
      invalid('A valid idempotency key is required.');
    const intent = await this.store.createPending({
      organizationId,
      purpose: 'WALLET_TOP_UP',
      amountMinor,
      currency: 'UGX',
      idempotencyKey: body.idempotencyKey,
    });
    return {
      id: intent.id,
      organizationId: intent.organizationId,
      purpose: intent.purpose,
      amountMinor: intent.amountMinor.toString(),
      currency: intent.currency,
      status: intent.status,
      idempotencyKey: intent.idempotencyKey,
      provider: intent.provider,
      environment: intent.environment,
      providerReference: intent.providerReference,
      createdAt: intent.createdAt.toISOString(),
      updatedAt: intent.updatedAt.toISOString(),
    };
  }
}
