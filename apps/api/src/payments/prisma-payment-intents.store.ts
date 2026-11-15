import { ConflictException } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';
import { DATABASE_CLIENT } from '../tokens.js';
import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';

import type { PaymentIntentStore, CreatePaymentIntentInput, PaymentIntentRecord, PaymentIntentStatus } from './payment-intents.store.js';

type PaymentTx = Pick<PrismaClient, 'paymentIntent'> & TenantWriteSql;
type PaymentDatabase = PaymentTx & {
  $transaction<T>(work: (tx: PaymentTx) => Promise<T>): Promise<T>;
};

@Injectable()
export class PrismaPaymentIntentStore implements PaymentIntentStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: PaymentDatabase) {}

  async createPending(input: CreatePaymentIntentInput): Promise<PaymentIntentRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize with membership changes, including retries of accepted intents.
      await authorizeTenantWrite(tx, input.organizationId, input.actorUserId, 'billing:update');
      const existing = await tx.paymentIntent.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (
          existing.amountMinor !== input.amountMinor ||
          existing.currency !== input.currency ||
          existing.purpose !== input.purpose
        ) {
          throw new ConflictException({ error: {
            code: 'idempotency_conflict',
            message: 'This request identifier was already used for a different payment intent.',
          } });
        }
        return this.toRecord(existing);
      }
      const created = await tx.paymentIntent.create({
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
    });
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
