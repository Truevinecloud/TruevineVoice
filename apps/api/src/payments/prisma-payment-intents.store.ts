import { ConflictException } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';
import { DATABASE_CLIENT } from '../tokens.js';

import { PaymentIntentStore, type CreatePaymentIntentInput, type PaymentIntentRecord, type PaymentIntentStatus } from './payment-intents.store.js';

@Injectable()
export class PrismaPaymentIntentStore implements PaymentIntentStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient) {}

  async createPending(input: CreatePaymentIntentInput): Promise<PaymentIntentRecord> {
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (
        existing.amountMinor !== input.amountMinor ||
        existing.currency !== input.currency ||
        existing.purpose !== input.purpose
      ) {
        throw new ConflictException({ error: { code: 'idempotency_conflict', message: 'This request identifier was already used for a different payment intent.' } });
      }
      return this.toRecord(existing);
    }
    try {
      const created = await this.prisma.paymentIntent.create({
        data: {
          organizationId: input.organizationId,
          purpose: input.purpose,
          amountMinor: input.amountMinor,
          currency: input.currency,
          status: 'PENDING',
          idempotencyKey: input.idempotencyKey,
        },
      });
      return this.toRecord(created);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'P2002') {
        const raced = await this.prisma.paymentIntent.findUnique({
          where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
        });
        if (raced) {
          if (raced.amountMinor !== input.amountMinor || raced.currency !== input.currency || raced.purpose !== input.purpose) {
            throw new ConflictException({ error: { code: 'idempotency_conflict', message: 'This request identifier was already used for a different payment intent.' } });
          }
          return this.toRecord(raced);
        }
      }
      throw error;
    }
  }

  async findById(organizationId: string, id: string): Promise<PaymentIntentRecord | null> {
    const row = await this.prisma.paymentIntent.findFirst({ where: { id, organizationId } });
    return row ? this.toRecord(row) : null;
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<PaymentIntentRecord | null> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: {
    id: string;
    organizationId: string;
    purpose: string;
    amountMinor: bigint;
    currency: string;
    status: string;
    idempotencyKey: string;
    provider: string | null;
    environment: string | null;
    providerReference: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentIntentRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      purpose: row.purpose,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status as PaymentIntentStatus,
      idempotencyKey: row.idempotencyKey,
      provider: row.provider,
      environment: row.environment,
      providerReference: row.providerReference,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
