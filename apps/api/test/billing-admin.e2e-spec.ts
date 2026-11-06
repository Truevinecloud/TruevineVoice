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
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

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
    await database.organization.createMany({
      data: [
        { id: ORG_A, slug: `billing-admin-a-${RUN}`, name: 'Billing admin test A' },
        { id: ORG_B, slug: `billing-admin-b-${RUN}`, name: 'Billing admin test B' },
      ],
    });
    store = new PrismaBillingAdminStore(database as never);
    audit = new PrismaAuditStore(database as never);
    service = new BillingAdminService(store as never, audit as never, { platformAuditEvents: async () => [] });
  });

  afterAll(async () => {
    await database?.walletEntry.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
    await database?.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await database?.$disconnect();
  });

  it('creates exactly one ledger entry for concurrent identical idempotency keys', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.adjustWallet({
          organizationId: ORG_A,
          actorUserId: randomUUID(),
          amountMinor: 1000n,
          currency: 'UGX',
          reason: 'Concurrent adjustment',
          idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((result) => result.created).length).toBe(1);
    const distinctIds = new Set(results.map((result) => result.entry.id));
    expect(distinctIds.size).toBe(1);
    const entries = await database.walletEntry.findMany({ where: { organizationId: ORG_A, reference: `billing-adjustment:${key}` } });
    expect(entries).toHaveLength(1);
  });

  it('rejects conflicting reuse of an idempotency key across amount, currency, organization, and reason', async () => {
    const key = randomUUID();
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: randomUUID(),
      amountMinor: 1000n,
      currency: 'UGX',
      reason: 'Original',
      idempotencyKey: key,
    });

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: randomUUID(),
        amountMinor: 2000n,
        currency: 'UGX',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: randomUUID(),
        amountMinor: 1000n,
        currency: 'USD',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: randomUUID(),
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Changed reason',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    await expect(
      store.adjustWallet({
        organizationId: ORG_B,
        actorUserId: randomUUID(),
        amountMinor: 1000n,
        currency: 'UGX',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    const entries = await database.walletEntry.findMany({ where: { reference: `billing-adjustment:${key}` } });
    expect(entries).toHaveLength(1);
  });

  it('does not leak an adjustment from one organization to another', async () => {
    const key = randomUUID();
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: randomUUID(),
      amountMinor: 500n,
      currency: 'UGX',
      reason: 'Org A only',
      idempotencyKey: key,
    });

    const orgBEntries = await database.walletEntry.findMany({ where: { organizationId: ORG_B, reference: `billing-adjustment:${key}` } });
    expect(orgBEntries).toHaveLength(0);
  });

  it('keeps ledger totals equal to the sum of committed entries after concurrent adjustments', async () => {
    const keys = Array.from({ length: 10 }, () => randomUUID());
    await Promise.all(
      keys.map((key, index) =>
        store.adjustWallet({
          organizationId: ORG_A,
          actorUserId: randomUUID(),
          amountMinor: BigInt((index % 3) === 0 ? -100 : 250),
          currency: 'UGX',
          reason: `Concurrent adjustment ${index}`,
          idempotencyKey: key,
        }),
      ),
    );

    const entries = await database.walletEntry.findMany({ where: { organizationId: ORG_A } });
    const groups = await database.walletEntry.groupBy({
      by: ['currency'],
      where: { organizationId: ORG_A },
      _sum: { amountMinor: true },
    });
    const total = entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);
    expect(groups.reduce((sum, group) => sum + (group._sum.amountMinor ?? 0n), 0n)).toBe(total);
  });

  it('records audit evidence for success, replay, validation failure, and conflict', async () => {
    const key = randomUUID();
    const beforeIdentity = (await auditRecordCount(database, 'identity')) ?? 0;
    const beforeSecurity = (await auditRecordCount(database, 'security')) ?? 0;

    const first = await service.adjustWallet(randomUUID(), ORG_A, {
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'Audit success',
      idempotencyKey: key,
    });
    expect(first.created).toBe(true);

    const replay = await service.adjustWallet(randomUUID(), ORG_A, {
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'Audit success',
      idempotencyKey: key,
    });
    expect(replay.created).toBe(false);

    await expect(
      service.adjustWallet(randomUUID(), ORG_A, {
        amountMinor: '0',
        currency: 'UGX',
        reason: 'Bad amount',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();

    await expect(
      service.adjustWallet(randomUUID(), ORG_A, {
        amountMinor: '2000',
        currency: 'UGX',
        reason: 'Conflict',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    const afterIdentity = await auditRecordCount(database, 'identity');
    const afterSecurity = await auditRecordCount(database, 'security');
    expect(afterIdentity).toBeGreaterThan(beforeIdentity);
    expect(afterSecurity).toBeGreaterThan(beforeSecurity);
  });

  it('surfaces a negative balance in reconciliation alerts', async () => {
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: randomUUID(),
      amountMinor: -999999999n,
      currency: 'UGX',
      reason: 'Force negative balance',
      idempotencyKey: randomUUID(),
    });

    const result = await service.reconciliation(randomUUID());
    expect(result.alerts.some((alert) => alert.organizationId === ORG_A && alert.currency === 'UGX')).toBe(true);
  });
});

async function auditRecordCount(database: PrismaClient, trail: 'identity' | 'security'): Promise<number> {
  if (trail === 'identity') {
    return database.identityAuditEvent.count();
  }
  return database.securityAuditEvent.count();
}