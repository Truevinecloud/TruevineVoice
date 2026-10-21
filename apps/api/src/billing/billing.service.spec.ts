import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeBillingStore } from '../../test/fakes/billing.fakes.js';
import { BillingService } from './billing.service.js';

describe('billing money and requests', () => {
  it('sums signed integer ledger entries without losing precision', async () => {
    const store = new FakeBillingStore();
    store.entries.set('a', [
      {
        id: randomUUID(),
        amountMinor: 9007199254740993n,
        currency: 'UGX',
        description: 'Confirmed',
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        amountMinor: -2n,
        currency: 'UGX',
        description: 'Correction',
        createdAt: new Date(),
      },
    ]);
    const service = new BillingService(store);
    expect(await service.wallet('a')).toEqual({ currency: 'UGX', amountMinor: '9007199254740991' });
    expect(await service.wallet('b')).toEqual({ currency: 'UGX', amountMinor: '0' });
    expect(JSON.stringify(await service.transactions('a'))).toContain('9007199254740993');
  });
  it('deduplicates concurrent requests without adding wallet credit', async () => {
    const store = new FakeBillingStore();
    const service = new BillingService(store);
    const body = { amountMinor: '10000', currency: 'UGX', idempotencyKey: randomUUID() };
    const [first, replay] = await Promise.all([
      service.requestTopUp('a', 'u', body),
      service.requestTopUp('a', 'u', body),
    ]);
    expect(first).toEqual(replay);
    expect(first.status).toBe('PENDING');
    expect(store.requests).toHaveLength(1);
    expect(await service.wallet('a')).toEqual({ amountMinor: '0', currency: 'UGX' });
    await expect(
      service.requestTopUp('a', 'u', { ...body, amountMinor: '20000' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.requestTopUp('b', 'u', body)).id).not.toBe(first.id);
  });
  it.each(['0', '-1', '1.2', '1e3', '01', '9223372036854775808', 123, null, ''])(
    'rejects unsafe amount %s',
    async (amountMinor) => {
      const store = new FakeBillingStore();
      await expect(
        new BillingService(store).requestTopUp('a', 'u', {
          amountMinor,
          currency: 'UGX',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(store.requests).toHaveLength(0);
    },
  );
  it('rejects unsupported currency and missing request identifiers', async () => {
    const service = new BillingService(new FakeBillingStore());
    await expect(
      service.requestTopUp('a', 'u', {
        amountMinor: '1',
        currency: 'USD',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.requestTopUp('a', 'u', { amountMinor: '1', currency: 'UGX' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('validates and scopes billing details, ignoring client tenant claims', async () => {
    const store = new FakeBillingStore();
    const service = new BillingService(store);
    await service.saveProfile(
      'a',
      {
        name: ' Company ',
        email: 'billing@example.com',
        address: ' Kampala ',
        organizationId: 'b',
      },
      'actor',
    );
    expect(store.profiles.get('a')?.name).toBe('Company');
    expect(store.profiles.has('b')).toBe(false);
    await expect(
      service.saveProfile('a', { name: 'Name', email: 'invalid', address: 'Address' }, 'actor'),
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.billing('a')).collectionAvailable).toBe(false);
  });
  it('paginates transaction history and validates cursor identifiers', async () => {
    const store = new FakeBillingStore();
    store.entries.set(
      'a',
      Array.from({ length: 51 }, () => ({
        id: randomUUID(),
        amountMinor: 1n,
        currency: 'UGX',
        description: 'Entry',
        createdAt: new Date(),
      })),
    );
    const service = new BillingService(store);
    const result = await service.transactions('a');
    expect(result.entries).toHaveLength(50);
    expect(result.nextCursor).toBe(result.entries[49]?.id);
    await expect(service.transactions('a', 'invalid')).rejects.toMatchObject({ status: 400 });
  });
});
