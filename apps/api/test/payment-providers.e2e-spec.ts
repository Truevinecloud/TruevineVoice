import { randomUUID } from 'node:crypto';

import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  PaymentProviderEnvironment,
  PaymentProvider,
} from '../src/payments/payment-provider.contracts.js';
import { PrismaPaymentProviderStore } from '../src/payments/prisma-payment-providers.store.js';
import type {
  SavePaymentProviderConfigurationInput,
  SetPaymentProviderActivationInput,
} from '../src/payments/payment-providers.store.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

/**
 * The migration and the Prisma store against a real PostgreSQL server.
 *
 * The unit suite uses an in-memory store, which cannot prove that the migration
 * applies, that the CHECK constraints and the partial unique index exist, or
 * that the row and its audit event commit together. Those are properties of the
 * database, so they are asserted here.
 *
 * Runs only against the explicitly disposable loopback database the rest of the
 * E2E suite uses (see `disposable-database.ts`). It never touches a database
 * this project does not own.
 */
describe('payment-provider persistence on disposable PostgreSQL', () => {
  let database: PrismaClient;
  let store: PrismaPaymentProviderStore;
  const actorUserId = randomUUID();
  const now = new Date('2026-10-30T12:00:00.000Z');
  const envelope = 'v1.test-envelope-for-persistence-spec';

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const disposable = assertDisposableDatabase(url, process.env['NODE_ENV']);
    database = createDatabaseClient(url);
    await assertConnectedToDisposableDatabase(async () => {
      const rows = await database.$queryRaw<Array<{ current: string }>>`
        SELECT current_database() AS current
      `;
      return rows[0]?.current;
    }, disposable);

    await database.user.create({
      data: {
        id: actorUserId,
        email: `payment-persistence-${actorUserId}@example.invalid`,
        passwordHash: 'unusable-fixture',
      },
    });

    // Only this suite writes this table, and only on a disposable database.
    // Clearing it makes the fixed (provider, environment) keys reusable across
    // local reruns without deleting the append-only audit trail.
    await database.paymentProviderConfiguration.deleteMany({});

    store = new PrismaPaymentProviderStore(database as unknown as never);
  });

  beforeEach(async () => {
    await database.paymentProviderConfiguration.deleteMany({});
  });

  afterAll(async () => {
    await database?.paymentProviderConfiguration.deleteMany({});
    await database?.$disconnect();
  });

  function saveInput(
    overrides: Partial<SavePaymentProviderConfigurationInput> = {},
  ): SavePaymentProviderConfigurationInput {
    return {
      provider: 'MTN_MOMO',
      environment: 'SANDBOX',
      credentialsCiphertext: envelope,
      credentialFields: ['subscriptionKey', 'apiUser', 'apiKey'],
      callbackUrl: 'https://voice.example.test/webhooks/mtn',
      actorUserId,
      expectedVersion: null,
      now,
      audit: {
        actorUserId,
        action: 'platform.payment_provider.configured',
        metadata: {
          provider: 'MTN_MOMO',
          environment: 'SANDBOX',
          savedFields: ['apiKey'],
          callbackConfigured: true,
          version: 1,
        },
      },
      ...overrides,
    };
  }

  function activationInput(
    active: boolean,
    environment: PaymentProviderEnvironment = 'SANDBOX',
  ): SetPaymentProviderActivationInput {
    return {
      provider: 'MTN_MOMO',
      environment,
      active,
      actorUserId,
      now,
      audit: {
        actorUserId,
        action: active
          ? 'platform.payment_provider.activated'
          : 'platform.payment_provider.deactivated',
        metadata: { provider: 'MTN_MOMO', environment, active },
      },
    };
  }

  function rawRow(
    overrides: Partial<{
      provider: PaymentProvider;
      environment: PaymentProviderEnvironment;
      callbackUrl: string | null;
      active: boolean;
      activatedAt: Date | null;
      deactivatedAt: Date | null;
    }> = {},
  ) {
    return {
      provider: 'AIRTEL_MONEY' as PaymentProvider,
      environment: 'SANDBOX' as PaymentProviderEnvironment,
      credentialsCiphertext: envelope,
      credentialFields: ['clientId'],
      callbackUrl: 'https://voice.example.test/webhooks/airtel',
      configuredAt: now,
      updatedByUserId: actorUserId,
      active: false,
      ...overrides,
    };
  }

  it('commits the encrypted row and its audit event together', async () => {
    const result = await store.save(saveInput());

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.record).toMatchObject({
      provider: 'MTN_MOMO',
      environment: 'SANDBOX',
      active: false,
      configuredAt: now,
      activatedAt: null,
      deactivatedAt: null,
      version: 1,
      updatedByUserId: actorUserId,
    });
    expect(result.record.credentialFields).toEqual(['subscriptionKey', 'apiUser', 'apiKey']);

    const audit = await database.identityAuditEvent.findMany({ where: { actorUserId } });
    expect(audit.at(-1)?.action).toBe('platform.payment_provider.configured');
    expect(JSON.stringify(audit)).not.toContain(envelope);
    expect(audit.at(-1)?.metadata).toMatchObject({ provider: 'MTN_MOMO', environment: 'SANDBOX' });
  });

  it('rejects a stale version and a change to an active configuration', async () => {
    const saved = await store.save(saveInput());
    if (saved.kind !== 'saved') throw new Error('fixture save failed');

    const stale = await store.save(
      saveInput({
        expectedVersion: saved.record.version + 1,
        credentialsCiphertext: 'v1.stale',
      }),
    );
    expect(stale.kind).toBe('version_conflict');

    await store.setActive(activationInput(true));
    const active = await store.save(
      saveInput({
        expectedVersion: saved.record.version + 1,
        credentialsCiphertext: 'v1.replacement',
      }),
    );
    expect(active.kind).toBe('active_conflict');
  });

  it('enforces the activation prerequisites and one active environment per provider', async () => {
    expect((await store.setActive(activationInput(true))).kind).toBe('not_configured');

    await store.save(saveInput({ callbackUrl: null }));
    expect((await store.setActive(activationInput(true))).kind).toBe('callback_required');

    await store.save(saveInput({ expectedVersion: 1 }));
    const activated = await store.setActive(activationInput(true));
    expect(activated.kind).toBe('updated');
    if (activated.kind === 'updated') {
      expect(activated.record).toMatchObject({ active: true, activatedAt: now });
    }

    await store.save(
      saveInput({
        environment: 'PRODUCTION',
        expectedVersion: null,
        audit: {
          actorUserId,
          action: 'platform.payment_provider.configured',
          metadata: {
            provider: 'MTN_MOMO',
            environment: 'PRODUCTION',
            savedFields: ['apiKey'],
            callbackConfigured: true,
            version: 1,
          },
        },
      }),
    );
    const other = await store.setActive(activationInput(true, 'PRODUCTION'));
    expect(other).toEqual({ kind: 'other_environment_active', environment: 'SANDBOX' });

    const deactivated = await store.setActive(activationInput(false));
    expect(deactivated.kind).toBe('updated');
    if (deactivated.kind === 'updated') {
      expect(deactivated.record).toMatchObject({ active: false, deactivatedAt: now });
    }
    expect((await store.setActive(activationInput(true, 'PRODUCTION'))).kind).toBe('updated');
  });

  it('enforces the migration CHECK constraints and unique indexes', async () => {
    // Active without a callback target.
    await expect(
      database.paymentProviderConfiguration.create({
        data: rawRow({ active: true, callbackUrl: null, activatedAt: now }),
      }),
    ).rejects.toThrow();

    // A callback URL cannot carry a query string or fragment.
    await expect(
      database.paymentProviderConfiguration.create({
        data: rawRow({ callbackUrl: 'https://voice.example.test/hook?token=x' }),
      }),
    ).rejects.toThrow();

    // One row per provider/environment.
    await database.paymentProviderConfiguration.create({ data: rawRow() });
    await expect(
      database.paymentProviderConfiguration.create({ data: rawRow({ provider: 'AIRTEL_MONEY' }) }),
    ).rejects.toThrow();
  });

  it('enforces at most one active environment per provider in the database', async () => {
    await database.paymentProviderConfiguration.create({
      data: rawRow({ active: true, environment: 'SANDBOX', activatedAt: now }),
    });

    await expect(
      database.paymentProviderConfiguration.create({
        data: rawRow({ active: true, environment: 'PRODUCTION', activatedAt: now }),
      }),
    ).rejects.toThrow();
  });
});
