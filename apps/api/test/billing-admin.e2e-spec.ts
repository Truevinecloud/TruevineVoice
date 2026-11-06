import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

import { PrismaBillingAdminStore } from '../src/billing-admin/prisma-billing-admin.store.js';

const ORG = randomUUID();
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

describe('RBAC-008 platform billing admin PostgreSQL safety', () => {
  let database: PrismaClient;
  let store: PrismaBillingAdminStore;

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
    await database.organization.create({ data: { id: ORG, slug: `billing-admin-${RUN}`, name: 'Billing admin test' } });
    store = new PrismaBillingAdminStore(database as never);
  });

  afterAll(async () => {
    await database?.walletEntry.deleteMany({ where: { organizationId: ORG } });
    await database?.organization.deleteMany({ where: { id: ORG } });
    await database?.$disconnect();
  });

  it('creates exactly one ledger entry for concurrent identical idempotency keys', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.adjustWallet({
          organizationId: ORG,
          actorUserId: randomUUID(),
          amountMinor: 1000n,
          currency: 'UGX',
          reason: 'Concurrent adjustment',
          idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((result) => result.created).length).toBe(1);
    const entries = await database.walletEntry.findMany({ where: { organizationId: ORG, reference: `billing-adjustment:${key}` } });
    expect(entries).toHaveLength(1);
  });

  it('rejects conflicting reuse of an idempotency key', async () => {
    const key = randomUUID();
    await store.adjustWallet({
      organizationId: ORG,
      actorUserId: randomUUID(),
      amountMinor: 1000n,
      currency: 'UGX',
      reason: 'Original',
      idempotencyKey: key,
    });

    await expect(
      store.adjustWallet({
        organizationId: ORG,
        actorUserId: randomUUID(),
        amountMinor: 2000n,
        currency: 'UGX',
        reason: 'Original',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();
  });

  it('keeps ledger totals equal to the sum of committed entries', async () => {
    const entries = await database.walletEntry.findMany({ where: { organizationId: ORG } });
    const groups = await database.walletEntry.groupBy({
      by: ['currency'],
      where: { organizationId: ORG },
      _sum: { amountMinor: true },
    });
    const total = entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);
    expect(groups.reduce((sum, group) => sum + (group._sum.amountMinor ?? 0n), 0n)).toBe(total);
  });
});
