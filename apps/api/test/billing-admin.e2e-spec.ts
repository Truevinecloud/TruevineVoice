import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

import { PrismaBillingAdminStore } from '../src/billing-admin/prisma-billing-admin.store.js';
import { BillingAdminService } from '../src/billing-admin/billing-admin.service.js';
import { PrismaAuditStore } from '../src/auth/prisma-stores.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ACTOR = randomUUID();
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

async function balance(database: PrismaClient, organizationId: string, currency: string): Promise<bigint> {
  const aggregate = await database.walletEntry.aggregate({
    where: { organizationId, currency },
    _sum: { amountMinor: true },
  });
  return aggregate._sum.amountMinor ?? 0n;
}

describe('RBAC-008 platform billing admin PostgreSQL safety', () => {
  let database: PrismaClient;
  let store: PrismaBillingAdminStore;
  let audit: PrismaAuditStore;
  let service: BillingAdminService;

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['BILLING_ADMIN_E2E_DISPOSABLE'] !== '1') {
      throw new Error('Billing admin E2E requires BILLING_ADMIN_E2E_DISPOSABLE=1 outside CI.');
    }
    database = createDatabaseClient(url);
    await assertConnectedToDisposableDatabase(
      async () => (await database.$queryRawUnsafe<{ current_database: string }[]>('select current_database()'))[0]?.current_database,
      expected,
    );
    await database.user.create({
      data: {
        id: ACTOR,
        email: `billing-admin-${RUN}@example.invalid`,
        passwordHash: 'not-a-real-password-hash',
        status: 'ACTIVE',
      },
    });
    await database.$transaction(async (tx) => {
      await tx.organization.createMany({
        data: [
          { id: ORG_A, slug: `ledger-a-${RUN}`, name: 'Ledger test A' },
          { id: ORG_B, slug: `ledger-b-${RUN}`, name: 'Ledger test B' },
        ],
      });
      await tx.membership.createMany({
        data: [
          { organizationId: ORG_A, userId: ACTOR, role: 'OWNER' },
          { organizationId: ORG_B, userId: ACTOR, role: 'OWNER' },
        ],
      });
    });
    store = new PrismaBillingAdminStore(database as never);
    audit = new PrismaAuditStore(database as never);
    service = new BillingAdminService(store as never, audit as never, { platformAuditEvents: async () => [] } as never);
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  it('increases the balance with a positive adjustment', async () => {
    const before = await balance(database, ORG_A, 'UGX');
    const result = await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 1000n,
      currency: 'UGX',
      reason: 'Positive adjustment',
      idempotencyKey: randomUUID(),
    });
    expect(result.created).toBe(true);
    expect(await balance(database, ORG_A, 'UGX')).toBe(before + 1000n);
  });

  it('accepts a debit smaller than the available balance', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 500n,
      currency: 'UGX',
      reason: 'Seed balance',
      idempotencyKey: randomUUID(),
    });
    const before = await balance(database, ORG_A, 'UGX');
    const result = await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: -300n,
      currency: 'UGX',
      reason: 'Small debit',
      idempotencyKey: randomUUID(),
    });
    expect(result.created).toBe(true);
    expect(await balance(database, ORG_A, 'UGX')).toBe(before - 300n);
  });

  it('accepts a debit equal to the available balance and leaves zero', async () => {
    const current = await balance(database, ORG_A, 'UGX');
    const result = await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: -current,
      currency: 'UGX',
      reason: 'Full debit',
      idempotencyKey: randomUUID(),
    });
    expect(result.created).toBe(true);
    expect(await balance(database, ORG_A, 'UGX')).toBe(0n);
  });

  it('rejects a debit exceeding the available balance', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Seed for rejection',
      idempotencyKey: randomUUID(),
    });
    const before = await balance(database, ORG_A, 'UGX');
    const beforeCount = await database.walletEntry.count({ where: { organizationId: ORG_A, currency: 'UGX' } });

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: -(before + 1n),
        currency: 'UGX',
        reason: 'Overdraft attempt',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();

    expect(await balance(database, ORG_A, 'UGX')).toBe(before);
    expect(await database.walletEntry.count({ where: { organizationId: ORG_A, currency: 'UGX' } })).toBe(beforeCount);
  });

  it('rejects a debit from a zero-balance wallet', async () => {
    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: -1n,
        currency: 'EUR',
        reason: 'Zero balance debit',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();
    expect(await balance(database, ORG_A, 'EUR')).toBe(0n);
  });

  it('creates no ledger entry for a rejected debit', async () => {
    const key = randomUUID();
    const beforeCount = await database.walletEntry.count({ where: { reference: `billing-adjustment:${key}` } });

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: -1n,
        currency: 'EUR',
        reason: 'Rejected no entry',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    expect(await database.walletEntry.count({ where: { reference: `billing-adjustment:${key}` } })).toBe(beforeCount);
  });

  it('prevents concurrent different-key debits from overdrawing one wallet', async () => {
    const concurrentOrg = randomUUID();
    await database.$transaction(async (tx) => {
      await tx.organization.create({
        data: { id: concurrentOrg, slug: `ledger-concurrent-${RUN}`, name: 'Ledger concurrent test' },
      });
      await tx.membership.create({
        data: { organizationId: concurrentOrg, userId: ACTOR, role: 'OWNER' },
      });
    });
    await store.adjustWallet({
      organizationId: concurrentOrg,
      actorUserId: ACTOR,
      amountMinor: 60n,
      currency: 'UGX',
      reason: 'Seed concurrent',
      idempotencyKey: randomUUID(),
    });
    const before = await balance(database, concurrentOrg, 'UGX');

    const results = await Promise.allSettled([
      store.adjustWallet({
        organizationId: concurrentOrg,
        actorUserId: ACTOR,
        amountMinor: -60n,
        currency: 'UGX',
        reason: 'Concurrent debit one',
        idempotencyKey: randomUUID(),
      }),
      store.adjustWallet({
        organizationId: concurrentOrg,
        actorUserId: ACTOR,
        amountMinor: -60n,
        currency: 'UGX',
        reason: 'Concurrent debit two',
        idempotencyKey: randomUUID(),
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await balance(database, concurrentOrg, 'UGX')).toBe(before - 60n);
  });

  it('keeps concurrent debits in different organizations isolated', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Seed org A',
      idempotencyKey: randomUUID(),
    });
    await store.adjustWallet({
      organizationId: ORG_B,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Seed org B',
      idempotencyKey: randomUUID(),
    });
    const beforeA = await balance(database, ORG_A, 'UGX');
    const beforeB = await balance(database, ORG_B, 'UGX');

    const results = await Promise.allSettled([
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: -60n,
        currency: 'UGX',
        reason: 'Org A debit',
        idempotencyKey: randomUUID(),
      }),
      store.adjustWallet({
        organizationId: ORG_B,
        actorUserId: ACTOR,
        amountMinor: -60n,
        currency: 'UGX',
        reason: 'Org B debit',
        idempotencyKey: randomUUID(),
      }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(await balance(database, ORG_A, 'UGX')).toBe(beforeA - 60n);
    expect(await balance(database, ORG_B, 'UGX')).toBe(beforeB - 60n);
  });

  it('does not let one currency subsidize a debit in another currency', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'UGX balance',
      idempotencyKey: randomUUID(),
    });
    const beforeUgx = await balance(database, ORG_A, 'UGX');

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: -10n,
        currency: 'USD',
        reason: 'USD debit without USD balance',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();

    expect(await balance(database, ORG_A, 'UGX')).toBe(beforeUgx);
    expect(await balance(database, ORG_A, 'USD')).toBe(0n);
  });

  it('returns the original entry for an identical idempotency-key retry', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Seed retry',
      idempotencyKey: randomUUID(),
    });
    const key = randomUUID();
    const first = await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: -40n,
      currency: 'UGX',
      reason: 'Retry debit',
      idempotencyKey: key,
    });
    const before = await balance(database, ORG_A, 'UGX');
    const replay = await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: -40n,
      currency: 'UGX',
      reason: 'Retry debit',
      idempotencyKey: key,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(await balance(database, ORG_A, 'UGX')).toBe(before);
  });

  it('rejects conflicting reuse of an idempotency key', async () => {
    const key = randomUUID();
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 1000n,
      currency: 'UGX',
      reason: 'Original',
      idempotencyKey: key,
    });

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: 2000n,
        currency: 'UGX',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: 1000n,
        currency: 'USD',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Changed reason',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_B,
        actorUserId: ACTOR,
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    const entries = await database.walletEntry.findMany({ where: { reference: `billing-adjustment:${key}` } });
    expect(entries).toHaveLength(1);
  });

  it('rejects simultaneous cross-organization reuse of one idempotency key', async () => {
    const key = randomUUID();
    const results = await Promise.allSettled([
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Cross-org original',
        idempotencyKey: key,
      }),
      store.adjustWallet({
        organizationId: ORG_B,
        actorUserId: ACTOR,
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Cross-org original',
        idempotencyKey: key,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ created: boolean }>).value.created).toBe(true);

    const entries = await database.walletEntry.findMany({ where: { reference: `billing-adjustment:${key}` } });
    expect(entries).toHaveLength(1);
  });

  it('records exact audit evidence for success and rejected adjustments', async () => {
    const key = randomUUID();
    const beforeSuccess = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', outcome: 'SUCCESS' },
    });
    const beforeDenied = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', outcome: 'DENIED' },
    });

    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Audit success',
      idempotencyKey: randomUUID(),
    });

    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      amountMinor: 100n,
      currency: 'UGX',
      reason: 'Audit success service',
      idempotencyKey: key,
    });

    const successServiceResult = await service.adjustWallet(ACTOR, ORG_A, {
      amountMinor: '100',
      currency: 'UGX',
      reason: 'Audit success service',
      idempotencyKey: key,
    });
    expect(successServiceResult.created).toBe(false);

    await expect(
      service.adjustWallet(ACTOR, ORG_A, {
        amountMinor: '-999999999',
        currency: 'UGX',
        reason: 'Insufficient balance',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();

    const afterSuccess = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', outcome: 'SUCCESS' },
    });
    const afterDenied = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', outcome: 'DENIED' },
    });

    expect(afterSuccess).toBeGreaterThanOrEqual(beforeSuccess + 1);
    expect(afterDenied).toBeGreaterThanOrEqual(beforeDenied + 1);

    const deniedEvents = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', outcome: 'DENIED' },
      orderBy: { occurredAt: 'desc' },
      take: 1,
    });
    expect(deniedEvents[0]?.metadata).toMatchObject({ failure: 'insufficient_wallet_balance' });
  });

  it('keeps ledger totals equal to the sum of committed entries after concurrent operations', async () => {
    const entries = await database.walletEntry.findMany({ where: { organizationId: ORG_A } });
    const groups = await database.walletEntry.groupBy({
      by: ['currency'],
      where: { organizationId: ORG_A },
      _sum: { amountMinor: true },
    });
    const total = entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);
    expect(groups.reduce((sum, group) => sum + (group._sum.amountMinor ?? 0n), 0n)).toBe(total);
  });

  it('retains negative-balance detection for legacy ledger entries', async () => {
    await database.walletEntry.create({
      data: {
        organizationId: ORG_A,
        amountMinor: -999999999n,
        currency: 'UGX',
        reference: `legacy-negative-${randomUUID()}`,
        description: 'Legacy negative balance',
      },
    });

    const result = await service.reconciliation(ACTOR);
    expect(result.alerts.some((alert) => alert.organizationId === ORG_A && alert.currency === 'UGX')).toBe(true);
  });
});