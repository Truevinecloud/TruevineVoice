import { describe, expect, it, vi } from 'vitest';

import { PaymentIntentsService } from '../src/payments/payment-intents.service.js';
import { FakePaymentIntentStore } from './fakes/payment-intents.fakes.js';

describe('PaymentIntentsService', () => {
  it('passes the verified actor and path scope instead of body claims to persistence', async () => {
    const store = new FakePaymentIntentStore();
    const persist = vi.spyOn(store, 'createPending');
    const result = await new PaymentIntentsService(store).createPending('org-a', 'user-a', {
      purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: crypto.randomUUID(),
      organizationId: 'org-b', org_id: 'org-b', actorUserId: 'user-b',
    });
    expect(result.organizationId).toBe('org-a');
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', actorUserId: 'user-a' }));
  });
  it('creates a pending intent for valid input', async () => {
    const store = new FakePaymentIntentStore();
    const service = new PaymentIntentsService(store as never);
    const result = await service.createPending('org-1', 'actor-1', {
      purpose: 'WALLET_TOP_UP',
      amountMinor: '5000',
      currency: 'UGX',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.status).toBe('PENDING');
    expect(result.amountMinor).toBe('5000');
    expect(result.currency).toBe('UGX');
  });

  it('returns same intent on identical retry', async () => {
    const store = new FakePaymentIntentStore();
    const service = new PaymentIntentsService(store as never);
    const key = crypto.randomUUID();
    const first = await service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: key });
    const second = await service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: key });
    expect(second.id).toBe(first.id);
  });

  it('rejects conflicting retry', async () => {
    const store = new FakePaymentIntentStore();
    const service = new PaymentIntentsService(store as never);
    const key = crypto.randomUUID();
    await service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: key });
    await expect(service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '6000', currency: 'UGX', idempotencyKey: key })).rejects.toBeDefined();
  });

  it('rejects invalid amount/currency/purpose', async () => {
    const store = new FakePaymentIntentStore();
    const service = new PaymentIntentsService(store as never);
    await expect(service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '0', currency: 'UGX', idempotencyKey: crypto.randomUUID() })).rejects.toBeDefined();
    await expect(service.createPending('org-1', 'actor-1', { purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'USD', idempotencyKey: crypto.randomUUID() })).rejects.toBeDefined();
    await expect(service.createPending('org-1', 'actor-1', { purpose: 'SUBSCRIPTION_RENEWAL', amountMinor: '5000', currency: 'UGX', idempotencyKey: crypto.randomUUID() })).rejects.toBeDefined();
  });
});
