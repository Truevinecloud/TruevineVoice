import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@truevine/database';

import type { BillingService } from '../billing/billing.service.js';
import type { PaymentIntentRecord } from './payment-intents.store.js';
import { PrismaPaymentIntentStore } from './prisma-payment-intents.store.js';
import { TopUpIntegrationService } from './top-up-integration.service.js';
import { TopUpReconciliation } from './top-up-reconciliation.js';
import type { TopUpDatabase } from './top-up-reconciliation.js';
import {
  signSyntheticCallback,
  SYNTHETIC_ENVIRONMENT,
  SYNTHETIC_PROVIDER,
  type SyntheticCallbackPayload,
  type SyntheticPaymentCallback,
} from './top-up-reconciliation.js';

const KEY = 'test-synthetic-key-0001';
const ORG = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-000000000003';
const IDEMPOTENCY_KEY = 'topup-integration-0001';
const AMOUNT = 5000n;

const topUpView = {
  id: 'topup-1',
  amountMinor: AMOUNT.toString(),
  currency: 'UGX',
  status: 'PENDING' as const,
  createdAt: new Date().toISOString(),
};

const intentRecord: PaymentIntentRecord = {
  id: 'intent-1',
  organizationId: ORG,
  purpose: 'WALLET_TOP_UP',
  amountMinor: AMOUNT,
  currency: 'UGX',
  status: 'PENDING',
  idempotencyKey: IDEMPOTENCY_KEY,
  provider: null,
  environment: null,
  providerReference: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function syntheticPayload(overrides: Partial<SyntheticCallbackPayload> = {}): SyntheticCallbackPayload {
  return {
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    eventId: 'evt-1',
    providerReference: `synthetic:${IDEMPOTENCY_KEY}`,
    status: 'SUCCESS',
    amountMinor: '5000',
    currency: 'UGX',
    ...overrides,
  };
}

function signedCallback(overrides: Partial<SyntheticCallbackPayload> = {}): SyntheticPaymentCallback {
  const payload = syntheticPayload(overrides);
  const signature = signSyntheticCallback(payload, KEY);
  return { ...payload, signature };
}

function makeService() {
  const billing = {
    requestTopUp: vi.fn().mockResolvedValue({
      id: 'topup-1',
      amountMinor: AMOUNT.toString(),
      currency: 'UGX',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    }),
  } as unknown as BillingService;

  const paymentIntents = {
    createPending: vi.fn().mockResolvedValue(intentRecord),
  } as unknown as PrismaPaymentIntentStore;

  const prisma = {
    paymentIntent: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockImplementation(({ where }) => {
        if (where.organizationId === ORG && where.id === intentRecord.id) {
          return Promise.resolve(intentRecord);
        }
        return Promise.resolve(null);
      }),
      update: vi.fn().mockResolvedValue({ ...intentRecord, providerReference: `synthetic:${IDEMPOTENCY_KEY}` }),
    },
  } as unknown as PrismaClient;

  const reconciliation = new TopUpReconciliation({} as unknown as TopUpDatabase, KEY);
  vi.spyOn(reconciliation, 'receive').mockResolvedValue({
    outcome: 'CREDITED',
    eventId: 'evt-1',
    organizationId: ORG,
    walletEntryId: 'wallet-1',
  });

  return {
    service: new TopUpIntegrationService(billing, paymentIntents, prisma, reconciliation),
    billing,
    paymentIntents,
    prisma,
    reconciliation,
  };
}

describe('TopUpIntegrationService', () => {
  it('creates a payment intent from a top-up request and marks it for synthetic settlement', async () => {
    const { service, billing, paymentIntents, prisma } = makeService();

    const result = await service.createIntentFromTopUp({
      organizationId: ORG,
      actorUserId: ACTOR,
      amountMinor: AMOUNT,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(billing.requestTopUp).toHaveBeenCalledWith(ORG, ACTOR, {
      amountMinor: AMOUNT.toString(),
      idempotencyKey: IDEMPOTENCY_KEY,
      currency: 'UGX',
    });
    expect(paymentIntents.createPending).toHaveBeenCalledWith({
      organizationId: ORG,
      actorUserId: ACTOR,
      purpose: 'WALLET_TOP_UP',
      amountMinor: AMOUNT,
      currency: 'UGX',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(prisma.paymentIntent.update).toHaveBeenCalled();
    expect(result.topUpRequest.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(result.intent.providerReference).toBe(`synthetic:${IDEMPOTENCY_KEY}`);
    expect(result.intent.provider).toBe(SYNTHETIC_PROVIDER);
    expect(result.intent.environment).toBe(SYNTHETIC_ENVIRONMENT);
  });

  it('does not create duplicate payment intents for repeated top-up requests', async () => {
    const { service, paymentIntents, prisma } = makeService();
    vi.mocked(prisma.paymentIntent.findUnique).mockResolvedValue(intentRecord);

    const result = await service.createIntentFromTopUp({
      organizationId: ORG,
      actorUserId: ACTOR,
      amountMinor: AMOUNT,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(paymentIntents.createPending).not.toHaveBeenCalled();
    expect(prisma.paymentIntent.update).not.toHaveBeenCalled();
    expect(result.intent.id).toBe(intentRecord.id);
  });

  it('rejects idempotency conflicts when the top-up amount changes', async () => {
    const { service, billing } = makeService();
    vi.mocked(billing.requestTopUp).mockResolvedValue({
      ...topUpView,
      amountMinor: '6000',
    });

    await expect(
      service.createIntentFromTopUp({
        organizationId: ORG,
        actorUserId: ACTOR,
        amountMinor: AMOUNT,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'idempotency_conflict' } },
    });
  });

  it('returns CREDITED for a successful synthetic settlement', async () => {
    const { service, reconciliation } = makeService();
    const callback = signedCallback();

    const result = await service.reconcileSyntheticTopUp(callback, KEY);

    expect(result.outcome).toBe('CREDITED');
    expect(reconciliation.receive).toHaveBeenCalledWith(callback);
  });

  it('returns REJECTED for a failed synthetic settlement', async () => {
    const { service, reconciliation } = makeService();
    vi.mocked(reconciliation.receive).mockResolvedValue({
      outcome: 'REJECTED',
      eventId: 'evt-2',
      organizationId: ORG,
      walletEntryId: null,
    });
    const callback = signedCallback({ status: 'FAILED', eventId: 'evt-2' });

    const result = await service.reconcileSyntheticTopUp(callback, KEY);

    expect(result.outcome).toBe('REJECTED');
  });

  it('returns ALREADY_RECONCILED for duplicate settlement', async () => {
    const { service, reconciliation } = makeService();
    vi.mocked(reconciliation.receive).mockResolvedValue({
      outcome: 'ALREADY_RECONCILED',
      eventId: 'evt-1',
      organizationId: ORG,
      walletEntryId: 'wallet-1',
    });
    const callback = signedCallback();

    const result = await service.reconcileSyntheticTopUp(callback, KEY);

    expect(result.outcome).toBe('ALREADY_RECONCILED');
  });

  it('fails closed for an invalid signature without calling reconciliation', async () => {
    const { service, reconciliation } = makeService();
    const callback = signedCallback();

    const result = await service.reconcileSyntheticTopUp(callback, 'wrong-key');

    expect(result.outcome).toBe('UNVERIFIED');
    expect(reconciliation.receive).not.toHaveBeenCalled();
  });

  it('returns RECONCILIATION_REQUIRED when settlement processing fails', async () => {
    const { service, reconciliation } = makeService();
    vi.mocked(reconciliation.receive).mockRejectedValue(new Error('database failure'));
    const callback = signedCallback({ eventId: 'evt-4' });

    const result = await service.reconcileSyntheticTopUp(callback, KEY);

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
  });

  it('enforces tenant isolation when reading intent status', async () => {
    const { service } = makeService();

    const status = await service.getIntentStatus('other-organization', intentRecord.id);

    expect(status).toBeNull();
  });

  it('returns intent status for the owning organization', async () => {
    const { service } = makeService();

    const status = await service.getIntentStatus(ORG, intentRecord.id);

    expect(status).toBe('PENDING');
  });
});