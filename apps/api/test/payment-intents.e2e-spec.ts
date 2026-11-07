import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertConnectedToDisposableDatabase, assertDisposableDatabase } from './disposable-database.js';

describe('Payment intents PostgreSQL foundation', () => {
  let database: PrismaClient;
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();
  const RUN = randomUUID().replace(/-/g, '').slice(0, 8);

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['BILLING_ADMIN_E2E_DISPOSABLE'] !== '1') {
      throw new Error('Payment intents E2E requires BILLING_ADMIN_E2E_DISPOSABLE=1 outside CI.');
    }
    database = createDatabaseClient(url);
    await assertConnectedToDisposableDatabase(
      async () => (await database.$queryRawUnsafe<{ current_database: string }[]>('select current_database()'))[0]?.current_database,
      expected,
    );
    await database.$transaction(async (tx) => {
      await tx.organization.createMany({ data: [{ id: ORG_A, slug: `pi-a-${RUN}`, name: 'PI test A' }, { id: ORG_B, slug: `pi-b-${RUN}`, name: 'PI test B' }] });
      await tx.membership.createMany({ data: [{ organizationId: ORG_A, userId: randomUUID(), role: 'OWNER' }] });
    });
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  it('creates a pending intent', async () => {
    const intent = await database.paymentIntent.create({
      data: { organizationId: ORG_A, purpose: 'WALLET_TOP_UP', amountMinor: 5000n, currency: 'UGX', status: 'PENDING', idempotencyKey: randomUUID() },
    });
    expect(intent.status).toBe('PENDING');
  });

  it('enforces idempotency uniqueness', async () => {
    const key = randomUUID();
    await database.paymentIntent.create({ data: { organizationId: ORG_A, purpose: 'WALLET_TOP_UP', amountMinor: 5000n, currency: 'UGX', status: 'PENDING', idempotencyKey: key } });
    await expect(database.paymentIntent.create({ data: { organizationId: ORG_A, purpose: 'WALLET_TOP_UP', amountMinor: 5000n, currency: 'UGX', status: 'PENDING', idempotencyKey: key } })).rejects.toBeDefined();
  });

  it('enforces composite FK for wallet credit', async () => {
    const intent = await database.paymentIntent.create({ data: { organizationId: ORG_A, purpose: 'WALLET_TOP_UP', amountMinor: 5000n, currency: 'UGX', status: 'PENDING', idempotencyKey: randomUUID() } });
    // valid credit
    await database.walletEntry.create({ data: { organizationId: ORG_A, amountMinor: 5000n, currency: 'UGX', reference: `pi-${randomUUID()}`, description: 'credit', paymentIntentId: intent.id } });
    // duplicate credit for same intent
    await expect(database.walletEntry.create({ data: { organizationId: ORG_A, amountMinor: 5000n, currency: 'UGX', reference: `pi2-${randomUUID()}`, description: 'dup', paymentIntentId: intent.id } })).rejects.toBeDefined();
    // org mismatch
    await expect(database.walletEntry.create({ data: { organizationId: ORG_B, amountMinor: 5000n, currency: 'UGX', reference: `pi3-${randomUUID()}`, description: 'mismatch', paymentIntentId: intent.id } })).rejects.toBeDefined();
  });
});
