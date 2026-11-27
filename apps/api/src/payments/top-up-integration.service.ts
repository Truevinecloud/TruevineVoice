import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { BillingService } from '../billing/billing.service.js';
import { DATABASE_CLIENT } from '../tokens.js';
import { PrismaPaymentIntentStore } from './prisma-payment-intents.store.js';
import type { PaymentIntentRecord } from './payment-intents.store.js';
import {
  SYNTHETIC_ENVIRONMENT,
  SYNTHETIC_PROVIDER,
  TopUpReconciliation,
  parseSyntheticCallback,
  type SyntheticPaymentCallback,
  verifySyntheticCallback,
} from './top-up-reconciliation.js';

export interface CreateIntentFromTopUpInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly amountMinor: bigint;
  readonly idempotencyKey: string;
}

export interface TopUpRequestView {
  readonly id: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: 'PENDING';
  readonly createdAt: string;
}

export interface IntegrationIntentResult {
  readonly topUpRequest: TopUpRequestView;
  readonly intent: PaymentIntentRecord;
}

export interface SettlementOutcome {
  readonly outcome: 'CREDITED' | 'ALREADY_RECONCILED' | 'REJECTED' | 'RECONCILIATION_REQUIRED' | 'UNVERIFIED';
  readonly eventId: string | null;
  readonly organizationId: string | null;
  readonly walletEntryId: string | null;
}

@Injectable()
export class TopUpIntegrationService {
  constructor(
    private readonly billing: BillingService,
    private readonly paymentIntents: PrismaPaymentIntentStore,
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    private readonly reconciliation: TopUpReconciliation,
  ) {}

  async createIntentFromTopUp(input: CreateIntentFromTopUpInput): Promise<IntegrationIntentResult> {
    const topUp = await this.billing.requestTopUp(input.organizationId, input.actorUserId, {
      amountMinor: input.amountMinor.toString(),
      idempotencyKey: input.idempotencyKey,
      currency: 'UGX',
    });

    if (topUp.amountMinor !== input.amountMinor.toString() || topUp.currency !== 'UGX') {
      throw new BadRequestException({
        error: { code: 'idempotency_conflict', message: 'This request identifier was already used for a different top-up amount.' },
      });
    }

    const existing = await this.prisma.paymentIntent.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      return {
        topUpRequest: {
          id: topUp.id,
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          amountMinor: BigInt(topUp.amountMinor),
          currency: topUp.currency,
          status: 'PENDING',
          createdAt: topUp.createdAt,
        },
        intent: existing as unknown as PaymentIntentRecord,
      };
    }

    const intent = await this.paymentIntents.createPending({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      purpose: 'WALLET_TOP_UP',
      amountMinor: input.amountMinor,
      currency: 'UGX',
      idempotencyKey: input.idempotencyKey,
    });

    const providerReference = `synthetic:${input.idempotencyKey}`;
    await this.prisma.paymentIntent.update({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      data: {
        provider: SYNTHETIC_PROVIDER,
        environment: SYNTHETIC_ENVIRONMENT,
        providerReference,
      },
    });

    return {
      topUpRequest: {
        id: topUp.id,
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: BigInt(topUp.amountMinor),
        currency: topUp.currency,
        status: 'PENDING',
        createdAt: topUp.createdAt,
      },
      intent: {
        ...intent,
        provider: SYNTHETIC_PROVIDER,
        environment: SYNTHETIC_ENVIRONMENT,
        providerReference,
      } as unknown as PaymentIntentRecord,
    };
  }

  async reconcileSyntheticTopUp(callback: unknown, verificationKey: string): Promise<SettlementOutcome> {
    let payload: SyntheticPaymentCallback;
    try {
      payload = parseSyntheticCallback(callback);
    } catch {
      return { outcome: 'UNVERIFIED', eventId: null, organizationId: null, walletEntryId: null };
    }

    try {
      if (!verifySyntheticCallback(payload, verificationKey)) {
        return { outcome: 'UNVERIFIED', eventId: payload.eventId, organizationId: null, walletEntryId: null };
      }
    } catch {
      return { outcome: 'UNVERIFIED', eventId: null, organizationId: null, walletEntryId: null };
    }

    try {
      const result = await this.reconciliation.receive(callback);
      return result as SettlementOutcome;
    } catch {
      return { outcome: 'RECONCILIATION_REQUIRED', eventId: null, organizationId: null, walletEntryId: null };
    }
  }

  async getIntentStatus(organizationId: string, intentId: string): Promise<PaymentIntentRecord['status'] | null> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: intentId, organizationId },
    });
    if (!intent) return null;
    return intent.status as PaymentIntentRecord['status'];
  }
}
