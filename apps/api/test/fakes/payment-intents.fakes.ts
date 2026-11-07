import { ConflictException } from '@nestjs/common';

import { type PaymentIntentRecord, type PaymentIntentStore, type CreatePaymentIntentInput } from '../../src/payments/payment-intents.store.js';

export class FakePaymentIntentStore implements PaymentIntentStore {
  private intents: PaymentIntentRecord[] = [];

  async createPending(input: CreatePaymentIntentInput): Promise<PaymentIntentRecord> {
    const existing = this.intents.find((i) => i.organizationId === input.organizationId && i.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== input.amountMinor || existing.currency !== input.currency || existing.purpose !== input.purpose) {
        throw new ConflictException({ error: { code: 'idempotency_conflict', message: 'conflict' } });
      }
      return { ...existing };
    }
    const created: PaymentIntentRecord = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      purpose: input.purpose,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'PENDING',
      idempotencyKey: input.idempotencyKey,
      provider: null,
      environment: null,
      providerReference: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.intents.push(created);
    return { ...created };
  }

  async findById(organizationId: string, id: string): Promise<PaymentIntentRecord | null> {
    const found = this.intents.find((i) => i.organizationId === organizationId && i.id === id);
    return found ? { ...found } : null;
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<PaymentIntentRecord | null> {
    const found = this.intents.find((i) => i.organizationId === organizationId && i.idempotencyKey === idempotencyKey);
    return found ? { ...found } : null;
  }
}
