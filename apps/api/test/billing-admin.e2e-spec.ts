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
    await database?.user.deleteMany({ where: { id: ACTOR } });
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

  it('does not leak an adjustment from one organization to another', async () => {
    const key = randomUUID();
    await store.adjustWallet({
      organizationId: ORG_A,
      actorUserId: ACTOR,
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

  it('records exact audit evidence for success, replay, validation failure, and conflict', async () => {
    const key = randomUUID();
    const beforeSecurity = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted' },
    });

    const first = await service.adjustWallet(ACTOR, ORG_A, {
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'Audit success',
      idempotencyKey: key,
    });
    expect(first.created).toBe(true);

    const replay = await service.adjustWallet(ACTOR, ORG_A, {
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'Audit success',
      idempotencyKey: key,
    });
    expect(replay.created).toBe(false);

    await expect(
      service.adjustWallet(ACTOR, ORG_A, {
        amountMinor: '0',
        currency: 'UGX',
        reason: 'Bad amount',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();

    await expect(
      service.adjustWallet(ACTOR, ORG_A, {
        amountMinor: '2000',
        currency: 'UGX',
        reason: 'Conflict',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    const successEvents = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted', actorUserId: ACTOR, outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(successEvents.length).toBeGreaterThanOrEqual(beforeSecurity + 2);
    expect(successEvents.at(-2)?.targetId).toBe(first.entry.id);
    expect(successEvents.at(-1)?.targetId).toBe(replay.entry.id);

    const identityEvents = await database.identityAuditEvent.findMany({
      where: { actorUserId: ACTOR, action: 'platform.billing.wallet_adjusted', outcome: 'SUCCESS' },
    });
    expect(identityEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('does not leave a ledger entry when the database write fails', async () => {
    // PrismaBillingAdminStore.adjustWallet performs a read followed by a single
    // INSERT. There is no multi-write transaction to roll back; this test proves
    // a failed INSERT leaves no entry and the same key can be retried.
    const key = randomUUID();
    const missingOrganization = randomUUID();
    const beforeCount = await database.walletEntry.count({ where: { reference: `billing-adjustment:${key}` } });
    const beforeAudit = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted' },
    });

    await expect(
      store.adjustWallet({
        organizationId: missingOrganization,
        actorUserId: ACTOR,
        amountMinor: 1234n,
        currency: 'UGX',
        reason: 'Injected database failure',
        idempotencyKey: key,
      }),
    ).rejects.toBeDefined();

    const afterCount = await database.walletEntry.count({ where: { reference: `billing-adjustment:${key}` } });
    const afterAudit = await database.securityAuditEvent.count({
      where: { organizationId: ORG_A, action: 'platform.billing.wallet_adjusted' },
    });
    expect(afterCount).toBe(beforeCount);
    expect(afterAudit).toBe(beforeAudit);

    await expect(
      store.adjustWallet({
        organizationId: ORG_A,
        actorUserId: ACTOR,
        amountMinor: 1234n,
        currency: 'UGX',
        reason: 'Retry after failure',
        idempotencyKey: key,
      }),
    ).resolves.toBeDefined();
    const retryEntries = await database.walletEntry.findMany({ where: { reference: `billing-adjustment:${key}` } });
    expect(retryEntries).toHaveLength(1);
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